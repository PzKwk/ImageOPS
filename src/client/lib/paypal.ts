declare global {
  interface Window {
    paypal?: {
      Buttons: (options: unknown) => {
        render: (selector: HTMLElement) => Promise<void>;
        close?: () => void;
      };
    };
  }
}

let paypalLoader: Promise<void> | null = null;

export function loadPayPalSdk(clientId: string, currency: string) {
  if (window.paypal) {
    return Promise.resolve();
  }

  if (!paypalLoader) {
    paypalLoader = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
        clientId
      )}&currency=${encodeURIComponent(currency)}&components=buttons`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("PayPal SDK konnte nicht geladen werden."));
      document.head.appendChild(script);
    });
  }

  return paypalLoader;
}
