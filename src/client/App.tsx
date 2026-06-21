import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  ChevronRight,
  Coins,
  Cpu,
  Download,
  FolderPlus,
  ImagePlus,
  Loader2,
  LogIn,
  LogOut,
  Rocket,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Upload,
  UserPlus,
  Wand2,
  X
} from "lucide-react";
import {
  apiGet,
  apiPost,
  apiUpload,
  getToken,
  setToken,
  type AppConfig,
  type GenerateResult,
  type ImageJob,
  type ImageSizePreset,
  type ImprovePromptResponse,
  type RtxInitResponse,
  type TokenPackage,
  type User
} from "./lib/api";
import { loadPayPalSdk } from "./lib/paypal";

type AuthMode = "login" | "register";

const brandName = "ImageOPS";
const productName = "ImageOPS PRO Lab";
const logoSrc = "/logo-web.jpg";

const emptyPrompt =
  "Cinematic ultra-detailed key art of a futuristic creator studio, precise lighting, premium product photography finish";

function formatCredits(value: number) {
  return new Intl.NumberFormat("de-DE").format(value);
}

function creditCostLabel(value: number) {
  return `${formatCredits(value)} ${value === 1 ? "Credit" : "Credits"}`;
}

function isFourK(size: string) {
  return size === "3840x2160" || size === "2160x3840" || size === "3840 x 2160" || size === "2160 x 3840";
}

function isTest1080(size: string) {
  return size === "1920x1080" || size === "1080x1920" || size === "1920 x 1080" || size === "1080 x 1920";
}

function outputTierLabel(job: ImageJob | null) {
  if (!job) return "Output";
  if (job.targetSize) return "8K";
  if (job.size.includes("1920") || job.size.includes("1080")) return "1080p";
  return "4K";
}

function AuthScreen({
  onAuthenticated
}: {
  onAuthenticated: (payload: { user: User; token: string }) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("Image Artist");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await apiPost<{ user: User; token: string }>(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        mode === "login" ? { email, password } : { name, email, password }
      );
      setToken(payload.token);
      onAuthenticated(payload);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Anmeldung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-visual" aria-label={productName}>
        <img src={logoSrc} alt={productName} />
        <div className="auth-visual-footer">
          <span>1080p Test Render</span>
          <span>4K Max Render</span>
          <span>RTX 8K Upscale</span>
          <span>Rob-Token Credits</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="brand-row">
          <img src={logoSrc} alt="" />
          <div>
            <strong>{productName}</strong>
            <span>{brandName} / Prompt, Referenzen, High-Quality Render</span>
          </div>
        </div>

        <div className="auth-switch" role="tablist" aria-label="Auth mode">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            <LogIn size={17} />
            Login
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            <UserPlus size={17} />
            Registrierung
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === "register" ? (
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} />
            </label>
          ) : null}
          <label>
            E-Mail
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Passwort
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 8 : 1}
              required
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-button" disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : mode === "login" ? <LogIn size={18} /> : <UserPlus size={18} />}
            {mode === "login" ? "Einloggen" : "Account erstellen"}
          </button>
        </form>

        <div className="security-row">
          <ShieldCheck size={18} />
          <span>Credits, PayPal-Capture und OpenAI-Key bleiben serverseitig.</span>
        </div>
      </section>
    </main>
  );
}

function PayPalButtons({
  config,
  selectedPackage,
  onCaptured
}: {
  config: AppConfig;
  selectedPackage: TokenPackage;
  onCaptured: (credits: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let buttons: { render: (selector: HTMLElement) => Promise<void>; close?: () => void } | null = null;
    const container = containerRef.current;

    async function mount() {
      if (!container || !config.paypalClientId) return;
      container.innerHTML = "";
      setError("");
      try {
        await loadPayPalSdk(config.paypalClientId, selectedPackage.currency);
        if (!active || !window.paypal) return;
        buttons = window.paypal.Buttons({
          style: {
            layout: "vertical",
            color: "blue",
            shape: "rect",
            label: "pay"
          },
          createOrder: async () => {
            const response = await apiPost<{ id: string }>("/api/paypal/create-order", {
              packageId: selectedPackage.id
            });
            return response.id;
          },
          onApprove: async (data: { orderID: string }) => {
            const response = await apiPost<{ credits: number }>("/api/paypal/capture-order", {
              orderId: data.orderID
            });
            onCaptured(response.credits);
          },
          onError: (paypalError: unknown) => {
            setError(paypalError instanceof Error ? paypalError.message : "PayPal-Zahlung fehlgeschlagen.");
          }
        });
        await buttons.render(container);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "PayPal ist nicht verfügbar.");
      }
    }

    mount();

    return () => {
      active = false;
      buttons?.close?.();
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [config.paypalClientId, onCaptured, selectedPackage]);

  if (!config.paypalClientId) {
    return <p className="store-note">PayPal ist noch nicht konfiguriert. Setze die Werte in der `.env`.</p>;
  }

  return (
    <>
      <div className="paypal-buttons" ref={containerRef} />
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}

function StorePanel({
  config,
  user,
  onUserUpdate
}: {
  config: AppConfig;
  user: User;
  onUserUpdate: (user: User) => void;
}) {
  const [selectedId, setSelectedId] = useState(config.tokenPackages[1]?.id ?? config.tokenPackages[0]?.id);
  const selectedPackage =
    config.tokenPackages.find((item) => item.id === selectedId) ?? config.tokenPackages[0];

  const handleCaptured = useCallback(
    (credits: number) => {
      onUserUpdate({ ...user, credits });
    },
    [onUserUpdate, user]
  );

  return (
    <section className={config.paypalEnabled ? "side-panel" : "side-panel disabled-panel"}>
      <div className="panel-title">
        <ShoppingCart size={18} />
        <h2>Rob-Token Store</h2>
      </div>
      {!config.paypalEnabled ? (
        <p className="store-note">PayPal ist aktuell deaktiviert. Der Store bleibt sichtbar, aber ausgegraut.</p>
      ) : null}
      <div className="credit-balance">
        <span>Verfügbar</span>
        <strong>{formatCredits(user.credits)}</strong>
        <small>Rob-Token Credits</small>
      </div>
      <div className="package-list">
        {config.tokenPackages.map((pack) => (
          <button
            className={pack.id === selectedPackage.id ? "package-row selected" : "package-row"}
            key={pack.id}
            type="button"
            disabled={!config.paypalEnabled}
            onClick={() => setSelectedId(pack.id)}
          >
            <span>
              <strong>{pack.label}</strong>
              <small>{formatCredits(pack.credits)} Credits</small>
            </span>
            <span className="price">
              {pack.price} {pack.currency}
            </span>
            {pack.badge ? <em>{pack.badge}</em> : null}
          </button>
        ))}
      </div>
      {config.paypalEnabled && selectedPackage ? (
        <PayPalButtons config={config} selectedPackage={selectedPackage} onCaptured={handleCaptured} />
      ) : null}
    </section>
  );
}

function HistoryPanel({ jobs }: { jobs: ImageJob[] }) {
  return (
    <section className="side-panel history-panel">
      <div className="panel-title">
        <BadgeCheck size={18} />
        <h2>Letzte Jobs</h2>
      </div>
      {jobs.length === 0 ? (
        <p className="empty-copy">Noch keine Render. Dein erstes Ergebnis erscheint hier.</p>
      ) : (
        <div className="history-list">
          {jobs.slice(0, 8).map((job) => (
            <article className="history-row" key={job.id}>
              {job.imageUrl ? <img src={job.imageUrl} alt="" /> : <div className="thumb-placeholder" />}
              <div>
                <strong>{job.targetSize ?? job.size}</strong>
                <span>{job.status}</span>
                <p>{job.prompt}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FileDrop({
  files,
  setFiles,
  maxUploadMb
}: {
  files: File[];
  setFiles: (files: File[]) => void;
  maxUploadMb: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function addFiles(nextFiles: FileList | null) {
    if (!nextFiles) return;
    const imageFiles = Array.from(nextFiles)
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, 6);
    setFiles([...files, ...imageFiles].slice(0, 6));
  }

  return (
    <div
      className="file-drop"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(event) => addFiles(event.target.files)}
      />
      <button type="button" className="ghost-button" onClick={() => inputRef.current?.click()}>
        <Upload size={17} />
        Referenzbilder
      </button>
      <span>PNG, JPG, WebP bis {maxUploadMb} MB</span>
      {files.length > 0 ? (
        <div className="file-strip">
          {files.map((file, index) => (
            <div className="file-chip" key={`${file.name}-${index}`}>
              <span>{file.name}</span>
              <button
                aria-label={`${file.name} entfernen`}
                type="button"
                onClick={() => setFiles(files.filter((_, fileIndex) => fileIndex !== index))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SizeButton({
  preset,
  active,
  onClick
}: {
  preset: ImageSizePreset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={active ? "size-button active" : "size-button"} onClick={onClick}>
      <strong>{preset.label}</strong>
      <span>{preset.output}</span>
      <small>
        {preset.aspect} / {preset.baseCost} Credits
      </small>
    </button>
  );
}

function SdkSetupPanel({
  config,
  onConfigUpdate
}: {
  config: AppConfig;
  onConfigUpdate: (config: AppConfig) => void;
}) {
  const [directory, setDirectory] = useState(config.upscaler.localDir || "C:\\localRTXup");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setDirectory(config.upscaler.localDir || "C:\\localRTXup");
  }, [config.upscaler.localDir]);

  async function initialize() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiPost<RtxInitResponse>("/api/rtx/local-init", { directory });
      onConfigUpdate({ ...config, upscaler: result.upscaler });
      setDirectory(result.setup.directory);
      setMessage(`Bereit: ${result.setup.directory}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "SDK-Ordner konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sdk-setup">
      <div className="panel-title">
        <FolderPlus size={18} />
        <h2>SDK Setup</h2>
      </div>
      <label>
        localRTXup Ordner
        <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
      </label>
      <button className="ghost-button setup-button" type="button" onClick={initialize} disabled={busy}>
        {busy ? <Loader2 className="spin" size={17} /> : <FolderPlus size={17} />}
        Wrapper erstellen
      </button>
      <small>
        Erstellt input/4k.png, output/8k.png, readme.txt und run.ps1. Den echten SDK-Befehl
        trägst du danach in run.ps1 ein.
      </small>
      {message ? <p className="form-warning">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

function Studio({
  config,
  user,
  onUserUpdate,
  onConfigUpdate,
  onLogout
}: {
  config: AppConfig;
  user: User;
  onUserUpdate: (user: User) => void;
  onConfigUpdate: (config: AppConfig) => void;
  onLogout: () => void;
}) {
  const [prompt, setPrompt] = useState(emptyPrompt);
  const [selectedSize, setSelectedSize] = useState(config.imageSizes[0]?.value ?? "3840x2160");
  const [background, setBackground] = useState<"opaque" | "transparent">("opaque");
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [activeJob, setActiveJob] = useState<ImageJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [improveBusyMode, setImproveBusyMode] = useState<string | null>(null);
  const [maxRenderBusy, setMaxRenderBusy] = useState(false);
  const [upscaleBusy, setUpscaleBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  const selectedPreset = useMemo(
    () => config.imageSizes.find((size) => size.value === selectedSize) ?? config.imageSizes[0],
    [config.imageSizes, selectedSize]
  );
  const totalCost = selectedPreset?.baseCost ?? 0;
  const activeOutputLabel = outputTierLabel(activeJob);
  const canUpscaleActiveJob =
    Boolean(activeJob?.imageUrl) &&
    Boolean(activeJob?.sourceImageUrl) &&
    !activeJob?.targetSize &&
    isFourK(activeJob?.size ?? "") &&
    config.upscaler.enabled &&
    config.upscaler.binaryFound;
  const canRenderMaxFromTest =
    Boolean(activeJob?.imageUrl) &&
    !activeJob?.targetSize &&
    isTest1080(activeJob?.size ?? "");
  const maxRenderCost =
    activeJob?.size === "1080 x 1920"
      ? config.imageSizes.find((size) => size.value === "2160x3840")?.baseCost ?? 15
      : config.imageSizes.find((size) => size.value === "3840x2160")?.baseCost ?? 15;

  useEffect(() => {
    apiGet<{ jobs: ImageJob[] }>("/api/jobs")
      .then((response) => {
        setJobs(response.jobs);
        setActiveJob(response.jobs[0] ?? null);
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedPreset) return;
    setBusy(true);
    setError("");
    setWarning("");

    const formData = new FormData();
    formData.append("prompt", prompt);
    formData.append("size", selectedPreset.value);
    formData.append("background", background);
    files.forEach((file) => formData.append("images", file));

    try {
      const result = await apiUpload<GenerateResult>("/api/images/generate", formData);
      onUserUpdate(result.user);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setActiveJob(result.job);
      setWarning(result.warning ?? "");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Render fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function improveCurrentPrompt(mode: string) {
    if (prompt.trim().length < 3) {
      setError("Bitte gib zuerst einen Prompt ein.");
      return;
    }

    setImproveBusyMode(mode);
    setError("");
    setWarning("");

    try {
      const result = await apiPost<ImprovePromptResponse>("/api/prompts/improve", {
        prompt,
        mode,
        aspectRatio: selectedPreset?.aspect,
        textStrictness: "default"
      });
      setPrompt(result.improvedPrompt);
      const me = await apiGet<{ user: User }>("/api/auth/me").catch(() => null);
      if (me) {
        onUserUpdate(me.user);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Prompt konnte nicht verbessert werden.");
    } finally {
      setImproveBusyMode(null);
    }
  }

  async function upscaleActiveJob() {
    if (!activeJob) return;
    setUpscaleBusy(true);
    setError("");
    setWarning("");
    try {
      const result = await apiPost<GenerateResult>(`/api/jobs/${activeJob.id}/upscale-8k`, {});
      onUserUpdate(result.user);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setActiveJob(result.job);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "RTX 8K Nachbearbeitung fehlgeschlagen.");
    } finally {
      setUpscaleBusy(false);
    }
  }

  async function renderMaxFromActiveJob() {
    if (!activeJob) return;
    setMaxRenderBusy(true);
    setError("");
    setWarning("");
    try {
      const result = await apiPost<GenerateResult>(`/api/jobs/${activeJob.id}/render-max`, {});
      onUserUpdate(result.user);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setActiveJob(result.job);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "4K Max Render fehlgeschlagen.");
    } finally {
      setMaxRenderBusy(false);
    }
  }

  return (
    <div className="studio-shell">
      <header className="app-header">
        <div className="brand-row">
          <img src={logoSrc} alt="" />
          <div>
            <strong>{productName}</strong>
            <span>
              {brandName} / {config.dataBackend} / {config.openaiModel} / {config.quality} / {config.outputFormat.toUpperCase()}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <div className="token-pill">
            <Coins size={17} />
            <strong>{formatCredits(user.credits)}</strong>
            <span>Credits</span>
          </div>
          <button className="icon-button" type="button" onClick={onLogout} title="Logout">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main className="studio-grid">
        <form className="control-panel" onSubmit={submit}>
          <div className="panel-title">
            <Wand2 size={18} />
            <h1>Render Pipeline</h1>
          </div>

          <div className="prompt-field">
            <div className="prompt-label-row">
              <label htmlFor="prompt-input">Prompt</label>
            </div>
            <div className="prompt-improve-actions">
              <button
                className="ghost-button prompt-improve-button"
                type="button"
                onClick={() => improveCurrentPrompt(config.promptRewrite.thinkingExtraHard.mode)}
                disabled={Boolean(improveBusyMode) || busy || prompt.trim().length < 3}
              >
                {improveBusyMode === config.promptRewrite.thinkingExtraHard.mode ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                <span>
                  {improveBusyMode === config.promptRewrite.thinkingExtraHard.mode
                    ? "Verbessere..."
                    : "GPT-5.5 thinking extra hard"}
                  <small>{creditCostLabel(config.promptRewrite.thinkingExtraHard.cost)}</small>
                </span>
              </button>
              <button
                className="ghost-button prompt-improve-button"
                type="button"
                onClick={() => improveCurrentPrompt(config.promptRewrite.proDefault.mode)}
                disabled={Boolean(improveBusyMode) || busy || prompt.trim().length < 3}
              >
                {improveBusyMode === config.promptRewrite.proDefault.mode ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                <span>
                  {improveBusyMode === config.promptRewrite.proDefault.mode ? "Verbessere..." : "GPT-5.5 Pro default"}
                  <small>{creditCostLabel(config.promptRewrite.proDefault.cost)}</small>
                </span>
              </button>
            </div>
            <textarea
              id="prompt-input"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              minLength={3}
              maxLength={4000}
              required
            />
          </div>

          <div className="size-grid">
            {config.imageSizes.map((preset) => (
              <SizeButton
                key={preset.id}
                preset={preset}
                active={preset.value === selectedSize}
                onClick={() => setSelectedSize(preset.value)}
              />
            ))}
          </div>

          <FileDrop files={files} setFiles={setFiles} maxUploadMb={config.maxUploadMb} />

          <div className="option-group">
            <span>Background</span>
            <div className="segmented-control">
              <button
                type="button"
                className={background === "opaque" ? "active" : ""}
                onClick={() => setBackground("opaque")}
              >
                Opaque
              </button>
              <button
                type="button"
                className={background === "transparent" ? "active" : ""}
                onClick={() => setBackground("transparent")}
              >
                Transparent
              </button>
            </div>
          </div>

          <SdkSetupPanel config={config} onConfigUpdate={onConfigUpdate} />

          <div className={config.upscaler.enabled && config.upscaler.binaryFound ? "upscale-row" : "upscale-row disabled"}>
            <span>
              <Cpu size={18} />
              <strong>localRTXup SDK</strong>
              <small>
                {config.upscaler.enabled && config.upscaler.binaryFound
                  ? `${config.upscaler.expectedInput ?? "input/4k.png"} -> ${config.upscaler.expectedOutput ?? "output/8k.png"}`
                  : "SDK-Pfad und PowerShell-Befehl in .env konfigurieren"}
              </small>
            </span>
            <Cpu size={18} />
          </div>

          <div className="cost-row">
            <span>
              <Sparkles size={17} />
              Aktueller Job
            </span>
            <strong>{totalCost} Rob-Token</strong>
          </div>

          {error ? <p className="form-error">{error}</p> : null}
          {warning ? <p className="form-warning">{warning}</p> : null}

          <button className="primary-button render-button" disabled={busy || !selectedPreset}>
            {busy ? <Loader2 className="spin" size={19} /> : <Rocket size={19} />}
            {busy ? "Render läuft" : "Bild generieren"}
          </button>
        </form>

        <section className="preview-stage">
          <div className="preview-toolbar">
            <span>
              <ImagePlus size={17} />
              Output
            </span>
            <div className="download-group">
              {activeJob?.imageUrl ? (
                <a href={activeJob.imageUrl} download className="download-button">
                  <Download size={17} />
                  {activeOutputLabel} PNG
                </a>
              ) : null}
              {activeJob?.imageJpgUrl ? (
                <a href={activeJob.imageJpgUrl} download className="download-button">
                  <Download size={17} />
                  {activeOutputLabel} JPG
                </a>
              ) : null}
              {activeJob?.sourceImageUrl && activeJob.targetSize ? (
                <a href={activeJob.sourceImageUrl} download className="download-button secondary">
                  <Download size={17} />
                  4K PNG
                </a>
              ) : null}
              {activeJob?.sourceImageJpgUrl && activeJob.targetSize ? (
                <a href={activeJob.sourceImageJpgUrl} download className="download-button secondary">
                  <Download size={17} />
                  4K JPG
                </a>
              ) : null}
            </div>
          </div>
          <div className="preview-canvas">
            {busy || upscaleBusy || maxRenderBusy ? (
              <div className="rendering-state">
                <Loader2 className="spin" size={38} />
                <strong>
                  {upscaleBusy
                    ? "localRTXup erzeugt 8K"
                    : maxRenderBusy
                      ? "1080p Test wird als 4K Max neu gerendert"
                      : "High-quality Render wird erzeugt"}
                </strong>
                <span>
                  {upscaleBusy
                    ? "Server schreibt input/4k.png, startet PowerShell und holt output/8k.png."
                    : maxRenderBusy
                      ? "Das 1080p Ergebnis wird als Referenz für einen neuen 4K-Render verwendet."
                      : "Text und Referenzbilder gehen an die OpenAI Image API."}
                </span>
              </div>
            ) : activeJob?.imageUrl ? (
              <img src={activeJob.imageUrl} alt="Generated output" />
            ) : (
              <div className="empty-preview">
                <img src={logoSrc} alt="" />
                <strong>Bereit für dein erstes Bild</strong>
                <span>Prompt schreiben, Format wählen und optional Referenzen hinzufügen.</span>
              </div>
            )}
          </div>
          <div className="preview-meta">
            <span>{activeJob?.targetSize ?? activeJob?.size ?? selectedPreset?.output}</span>
            <ChevronRight size={16} />
            <span>{activeJob ? `${activeJob.totalCost} Credits` : `${totalCost} Credits`}</span>
            <ChevronRight size={16} />
            <span>{activeJob?.status ?? "ready"}</span>
          </div>
          {activeJob?.imageUrl ? (
            <div className="postprocess-bar">
              <div>
                <strong>{canRenderMaxFromTest ? "Vom Test zum Max Render" : "Lokale Nachbearbeitung"}</strong>
                <span>
                  {canRenderMaxFromTest
                    ? "1080p prüfen, dann dasselbe Ergebnis als Referenz für 4K Max verwenden."
                    : "Nur 4K-Max-Ergebnisse können an localRTXup gesendet und als 8K zurückgeholt werden."}
                </span>
              </div>
              {canRenderMaxFromTest ? (
                <button
                  className="primary-button compact"
                  type="button"
                  disabled={maxRenderBusy}
                  onClick={renderMaxFromActiveJob}
                >
                  {maxRenderBusy ? <Loader2 className="spin" size={18} /> : <Rocket size={18} />}
                  4K Max ({maxRenderCost} credits)
                </button>
              ) : null}
              <button
                className="primary-button compact"
                type="button"
                disabled={!canUpscaleActiveJob || upscaleBusy || maxRenderBusy}
                onClick={upscaleActiveJob}
              >
                {upscaleBusy ? <Loader2 className="spin" size={18} /> : <Cpu size={18} />}
                RTX 8K ({config.upscaler.upscaleCost} credits)
              </button>
            </div>
          ) : null}
        </section>

        <aside className="right-rail">
          <StorePanel config={config} user={user} onUserUpdate={onUserUpdate} />
          <HistoryPanel jobs={jobs} />
        </aside>
      </main>
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    async function boot() {
      try {
        const loadedConfig = await apiGet<AppConfig>("/api/config");
        setConfig(loadedConfig);
        if (getToken()) {
          const me = await apiGet<{ user: User }>("/api/auth/me");
          setUser(me.user);
        }
      } catch {
        setToken(null);
      } finally {
        setBooting(false);
      }
    }
    boot();
  }, []);

  function logout() {
    setToken(null);
    setUser(null);
  }

  if (booting || !config) {
    return (
      <main className="loading-shell">
        <Loader2 className="spin" size={32} />
        <span>{productName} startet</span>
      </main>
    );
  }

  if (!user) {
    return <AuthScreen onAuthenticated={({ user: nextUser }) => setUser(nextUser)} />;
  }

  return <Studio config={config} user={user} onUserUpdate={setUser} onConfigUpdate={setConfig} onLogout={logout} />;
}
