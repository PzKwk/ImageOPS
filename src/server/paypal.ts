import { randomUUID } from "node:crypto";
import { config, findPurchasablePackage, type TokenPackage } from "./config.js";
import { AppError } from "./http.js";
import { readStore, updateStore, type PayPalOrder } from "./store.js";

function paypalBaseUrl() {
  return config.paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function assertPayPalConfigured() {
  if (!config.paypalEnabled) {
    throw new AppError(503, "paypal_disabled", "PayPal ist aktuell deaktiviert.");
  }

  if (!config.paypalClientId || !config.paypalClientSecret) {
    throw new AppError(
      503,
      "paypal_not_configured",
      "PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET sind nicht gesetzt."
    );
  }
}

async function getPayPalAccessToken() {
  assertPayPalConfigured();
  const credentials = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString(
    "base64"
  );
  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    throw new AppError(502, "paypal_auth_failed", "PayPal OAuth konnte kein Token erzeugen.");
  }

  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new AppError(502, "paypal_auth_failed", "PayPal OAuth-Antwort enthaelt kein Token.");
  }

  return json.access_token;
}

function monthKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isCapturedInCurrentMonth(order: PayPalOrder, packageId: string) {
  if (order.packageId !== packageId || order.status !== "captured") {
    return false;
  }

  return monthKey(order.capturedAt ?? order.createdAt) === monthKey(new Date());
}

async function assertMonthlyPackageAvailable(userId: string, pack: TokenPackage) {
  if (!pack.monthlyLimit) {
    return;
  }

  const monthlyPurchases = await readStore(
    (store) =>
      store.paypalOrders.filter(
        (order) => order.userId === userId && isCapturedInCurrentMonth(order, pack.id)
      ).length
  );

  if (monthlyPurchases >= pack.monthlyLimit) {
    throw new AppError(
      409,
      "monthly_package_limit_reached",
      "Dieses Monatsangebot wurde diesen Monat bereits genutzt."
    );
  }
}

export async function createPayPalOrder(userId: string, packageId: string) {
  const pack = findPurchasablePackage(packageId);
  if (!pack) {
    throw new AppError(400, "invalid_package", "Unbekanntes Rob-Token-Paket.");
  }

  await assertMonthlyPackageAvailable(userId, pack);

  const accessToken = await getPayPalAccessToken();
  const localOrderId = randomUUID();
  const response = await fetch(`${paypalBaseUrl()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: pack.id,
          custom_id: localOrderId,
          description: `${pack.credits} Rob-Token Credits`,
          amount: {
            currency_code: pack.currency,
            value: pack.price
          }
        }
      ]
    })
  });

  const json = (await response.json()) as { id?: string; message?: string };
  if (!response.ok || !json.id) {
    throw new AppError(502, "paypal_create_failed", json.message ?? "PayPal Order konnte nicht erstellt werden.");
  }

  await updateStore((store) => {
    store.paypalOrders.push({
      id: localOrderId,
      userId,
      packageId: pack.id,
      paypalOrderId: json.id as string,
      credits: pack.credits,
      amount: pack.price,
      currency: pack.currency,
      status: "created",
      createdAt: new Date().toISOString()
    });
  });

  return { id: json.id };
}

export async function capturePayPalOrder(userId: string, paypalOrderId: string) {
  const localOrder = await updateStore((store) => {
    const order = store.paypalOrders.find(
      (item) => item.paypalOrderId === paypalOrderId && item.userId === userId
    );
    if (!order) {
      throw new AppError(404, "paypal_order_not_found", "PayPal Order wurde nicht gefunden.");
    }
    return { ...order };
  });

  const pack = findPurchasablePackage(localOrder.packageId);
  if (!pack) {
    throw new AppError(400, "invalid_package", "Unbekanntes Rob-Token-Paket.");
  }

  if (localOrder.status === "captured") {
    const user = await updateStore((store) => {
      const existing = store.users.find((item) => item.id === userId);
      if (!existing) {
        throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
      }
      return { credits: existing.credits };
    });
    return { credits: user.credits, alreadyCaptured: true };
  }

  await assertMonthlyPackageAvailable(userId, pack);

  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${paypalBaseUrl()}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });
  const json = (await response.json()) as { status?: string; message?: string };

  if (!response.ok || json.status !== "COMPLETED") {
    throw new AppError(502, "paypal_capture_failed", json.message ?? "PayPal Capture ist fehlgeschlagen.");
  }

  const result = await updateStore((store) => {
    const order = store.paypalOrders.find(
      (item) => item.paypalOrderId === paypalOrderId && item.userId === userId
    );
    const user = store.users.find((item) => item.id === userId);
    if (!order || !user) {
      throw new AppError(404, "paypal_order_not_found", "PayPal Order wurde nicht gefunden.");
    }
    if (order.status !== "captured") {
      user.credits += order.credits;
      order.status = "captured";
      order.capturedAt = new Date().toISOString();
    }

    return { credits: user.credits, addedCredits: order.credits };
  });

  return { ...result, alreadyCaptured: false };
}
