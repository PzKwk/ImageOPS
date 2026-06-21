export type User = {
  id: string;
  email: string;
  name: string;
  credits: number;
  createdAt: string;
};

export type TokenPackage = {
  id: string;
  label: string;
  credits: number;
  price: string;
  currency: string;
  badge?: string;
};

export type ImageSizePreset = {
  id: string;
  label: string;
  value: string;
  aspect: string;
  baseCost: number;
  output: string;
};

export type UpscalerStatus = {
  enabled: boolean;
  mode: string;
  configured: boolean;
  binaryFound: boolean;
  target: string;
  upscaleCost: number;
  sdkRepo: string;
  sdkDownloadScript: string;
  localDir?: string;
  expectedInput?: string;
  expectedOutput?: string;
};

export type PromptRewriteOption = {
  mode: string;
  model: string;
  cost: number;
};

export type AppConfig = {
  openaiModel: string;
  dataBackend: string;
  quality: string;
  outputFormat: string;
  paypalEnabled: boolean;
  paypalClientId?: string;
  paypalCurrency: string;
  tokenPackages: TokenPackage[];
  imageSizes: ImageSizePreset[];
  promptRewrite: {
    thinkingExtraHard: PromptRewriteOption;
    proDefault: PromptRewriteOption;
  };
  maxUploadMb: number;
  upscaler: UpscalerStatus;
};

export type ImageJob = {
  id: string;
  prompt: string;
  size: string;
  background?: "opaque" | "transparent";
  targetSize?: string;
  baseCost: number;
  upscaleCost: number;
  totalCost: number;
  status: "pending" | "completed" | "partial" | "failed";
  sourceImageUrl?: string;
  sourceImageJpgUrl?: string;
  imageUrl?: string;
  imageJpgUrl?: string;
  error?: string;
  referenceCount: number;
  createdAt: string;
  completedAt?: string;
};

export type GenerateResult = {
  job: ImageJob;
  user: User;
  warning?: string;
};

export type ImprovePromptResponse = {
  improvedPrompt: string;
};

export type RtxInitResponse = {
  setup: {
    directory: string;
    inputFile: string;
    outputFile: string;
    readme: string;
    runScript: string;
  };
  upscaler: UpscalerStatus;
};

const tokenKey = "imageops.authToken";

export function getToken() {
  return localStorage.getItem(tokenKey);
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem(tokenKey, token);
  } else {
    localStorage.removeItem(tokenKey);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message ?? "Request failed";
    throw new Error(message);
  }
  return data as T;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T>(path: string) {
  const response = await fetch(path, {
    headers: {
      ...authHeaders()
    }
  });
  return parseResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

export async function apiUpload<T>(path: string, body: FormData) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...authHeaders()
    },
    body
  });
  return parseResponse<T>(response);
}
