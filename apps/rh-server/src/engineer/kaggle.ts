// The engineer's Kaggle runner (spec engineer: Fine-tuned embedder on Kaggle; design v1-8 D4): free GPU hours through
// Kaggle's API (the calls the official kagglesdk makes): save a private script kernel with GPU, poll its session
// status, list its output files and download them.
export const KAGGLE_API = "https://api.kaggle.com/v1/kernels.KernelsApiService";

export interface KaggleCredentials {
  username: string;
  /** A new-style API token (Bearer) or a legacy key (HTTP Basic with the username). */
  token?: string;
  key?: string;
}

export class KaggleUnavailable extends Error {}

export type Request = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export function kaggleCredentials(get: (name: string) => string | undefined): KaggleCredentials {
  const username = get("KAGGLE_USERNAME")?.trim();
  const token = get("KAGGLE_API_TOKEN")?.trim();
  const key = get("KAGGLE_KEY")?.trim();
  if (!username || (!token && !key))
    throw new KaggleUnavailable(
      "set KAGGLE_USERNAME and KAGGLE_API_TOKEN in .env (free: kaggle.com → Settings → API → Create New Token) to train on Kaggle's free GPUs",
    );
  return { username, ...(token ? { token } : {}), ...(key ? { key } : {}) };
}

export class KaggleRunner {
  constructor(
    private readonly deps: {
      request: Request;
      credentials: KaggleCredentials;
      sleep?: (ms: number) => Promise<void>;
      pollMs?: number;
      maxWaitMs?: number;
      onStatus?: (status: string) => void;
    },
  ) {}

  private get auth(): string {
    const { token, key, username } = this.deps.credentials;
    return token ? `Bearer ${token}` : `Basic ${Buffer.from(`${username}:${key}`).toString("base64")}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.deps.request(`${KAGGLE_API}/${method}`, {
      method: "POST",
      headers: { authorization: this.auth, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Kaggle ${method}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Push a private GPU script kernel `<username>/<slug>` and run it. */
  async push(slug: string, title: string, script: string): Promise<{ ref: string; url?: string }> {
    const ref = `${this.deps.credentials.username}/${slug}`;
    const r = await this.call<{ ref?: string; url?: string; error?: string }>("SaveKernel", {
      slug: ref,
      newTitle: title,
      text: script,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
    });
    if (r.error) throw new Error(`Kaggle SaveKernel: ${r.error}`);
    return { ref: r.ref ?? ref, ...(r.url ? { url: r.url } : {}) };
  }

  async status(slug: string): Promise<{ status: string; failureMessage?: string }> {
    return this.call("GetKernelSessionStatus", { userName: this.deps.credentials.username, kernelSlug: slug });
  }

  async output(slug: string): Promise<{ files: { url: string; fileName: string }[]; log?: string }> {
    const r = await this.call<{ files?: { url: string; fileName: string }[]; log?: string }>(
      "ListKernelSessionOutput",
      {
        userName: this.deps.credentials.username,
        kernelSlug: slug,
      },
    );
    return { files: r.files ?? [], ...(r.log ? { log: r.log } : {}) };
  }

  /** Wait until the kernel is COMPLETE (or throw on ERROR, a cancel, or the time limit). */
  async wait(slug: string): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.deps.maxWaitMs ?? 6 * 3_600_000);
    let last = "";
    for (;;) {
      const s = await this.status(slug);
      const status = String(s.status ?? "")
        .replace(/^KERNEL_WORKER_STATUS_/, "")
        .toUpperCase();
      if (status !== last) this.deps.onStatus?.(status);
      last = status;
      if (status === "COMPLETE") return;
      if (status === "ERROR" || status.startsWith("CANCEL"))
        throw new Error(`the Kaggle run ended with ${status}${s.failureMessage ? `: ${s.failureMessage}` : ""}`);
      if (Date.now() > deadline) throw new Error("the Kaggle run did not finish within its time limit");
      await sleep(this.deps.pollMs ?? 60_000);
    }
  }
}
