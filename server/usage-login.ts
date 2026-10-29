import { mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { UsageProviderId } from "../shared/protocol.ts";
import type { UsageLoginStarted } from "../shared/usage-login.ts";
import { HerdrError, paneGet, paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { psQuote } from "./powershell.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";
import { localSignInPlace, systemUsageContext, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const LOGIN = {
  claude: { cli: "claude", binaries: ["claude"], args: ["auth", "login"] },
  codex: { cli: "codex", binaries: ["codex"], args: ["login"] },
  cursor: { cli: "Cursor CLI (agent)", binaries: ["agent", "cursor-agent"], args: ["login"] },
  copilot: { cli: "GitHub CLI (gh)", binaries: ["gh"], args: ["auth", "login", "--hostname", "github.com"] },
  grok: { cli: "grok", binaries: ["grok"], args: ["login"] },
  antigravity: { cli: "Antigravity CLI (agy)", binaries: ["agy"], args: null },
  opencode: { cli: "opencode", binaries: ["opencode"], args: ["auth", "login"] },
} as const;

/**
 * What the sign-in line sets first in `shell`: the credential home `name` names (`home`), or none
 * (null: the default home). The pane's shell may have inherited another account's home, so the
 * default one is reached by removing the variable, not by leaving it out of the tab's environment.
 */
function credentialHomePrefix(shell: PaneShell, name: string, home: string | null): string {
  if (shell === "posix") return `${shellCommandLine("posix", "env", home === null ? ["-u", name] : [`${name}=${home}`])} `;
  if (shell === "powershell") return home === null ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue; ` : `$env:${name} = ${psQuote(home)}; `;
  if (/["%\r\n]/.test(home ?? "")) throw new Error("this credential home cannot be typed into cmd.exe");
  return `set "${name}=${home ?? ""}" & `;
}

/**
 * One directory's one name, however it is reached: its real path through any symlink, or for a home
 * not made yet, its nearest existing parent's real path and the rest. Two logins locked by spelling
 * would both write one home reached through an alias. Throws when it cannot be told (a directory it
 * may not read): a guess would let a second login in.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/** The login holding a credential home: its pane, and its shell's pid (with exec, the CLI's own) when herdr said it. */
interface LoginHolder { readonly pane: string; readonly pid: number | null }

/** Whether a process still runs (one of another user is still running too). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

/** Only panes this service launched invalidate usage when their login process exits. */
export class UsageLoginService {
  private readonly panes = new Set<string>();
  /**
   * One login at a time per credential home, Add account and Sign in again alike: two CLIs writing
   * one home race each other's tokens. By home, the login holding it: its pane, and its shell's pid
   * (with exec, the CLI's own), which a move to another workspace keeps while the pane ID changes;
   * null while launching, until its tab opens.
   */
  private readonly logins = new Map<string, LoginHolder | null>();
  /** where the holders are kept for the next server: a login runs in a herdr tab, which outlives this one (#2313) */
  private file: string | null = null;

  constructor(private readonly home = homedir(), private readonly env = process.env,
    private readonly context: UsageContext = { ...systemUsageContext(), home, env }) {}

  ended(paneId: string): boolean {
    let released = false;
    for (const [home, holder] of this.logins) if (holder?.pane === paneId) { this.logins.delete(home); released = true; }
    if (released) this.save();
    return this.panes.delete(paneId);
  }

  /**
   * Keeps the homes' holders in `stateDir`, and takes back those a server before this one kept there. Each
   * holds only as long as `reserve()` finds its login still running in herdr. A file that will not read
   * holds none: atomic writes leave none half written, and refusing every sign-in for good is no answer.
   */
  persistTo(stateDir: string): void {
    this.file = join(stateDir, "usage-logins.json");
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) console.warn("Could not read the sign-ins a previous server left running", error);
      return;
    }
    const logins = isJsonObject(saved) && Array.isArray(saved["logins"]) ? saved["logins"] : [];
    for (const login of logins) {
      if (!isJsonObject(login) || typeof login["home"] !== "string" || typeof login["pane"] !== "string"
        || !(login["pid"] === null || (typeof login["pid"] === "number" && Number.isSafeInteger(login["pid"]) && login["pid"] > 0))) continue;
      if (!this.logins.has(login["home"])) this.logins.set(login["home"], { pane: login["pane"], pid: login["pid"] as number | null });
    }
  }

  /** Writes the holders of the logins whose tab is open; a launch that has none yet is not kept. */
  private save(): void {
    if (this.file === null) return;
    const logins = [...this.logins].flatMap(([home, holder]) => holder === null ? [] : [{ home, pane: holder.pane, pid: holder.pid }]);
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ logins })}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) { console.warn("Could not keep the running sign-ins for the next server", error); }
  }

  /**
   * Whether `holder`'s login still runs, from what herdr says now: its pane is there running its pid (a
   * pane ID can be handed on once it closed), or its pid is the shell of another pane (it moved to another
   * workspace, which changes its pane ID). A pid alone proves nothing: after a reboot it can name anything.
   * When herdr cannot say, it holds: a guess would let a second login in.
   */
  private async holds(holder: LoginHolder): Promise<boolean> {
    const unknownPane = (error: unknown) => error instanceof HerdrError && error.code === "pane_not_found";
    try {
      await paneGet(holder.pane);
      if (holder.pid === null) return true;
      const shell = (await paneProcessInfo(holder.pane))?.shell_pid;
      if (shell === undefined || shell === null || shell === holder.pid) return true;
    } catch (error) { if (!unknownPane(error)) return true; }
    if (holder.pid === null || !processAlive(holder.pid)) return false;
    try {
      const { panes } = await sessionSnapshot();
      const shells = await Promise.all(panes.map(({ pane_id }) => paneProcessInfo(pane_id).then((info) => info?.shell_pid, (error: unknown) => {
        if (unknownPane(error)) return undefined;
        throw error;
      })));
      return shells.includes(holder.pid);
    } catch { return true; }
  }

  /**
   * Takes `home` for one launch; false while another login holds it. A holder lets go once its login no
   * longer runs in herdr (`holds()`): its exit went unseen, or it ended while no server ran.
   */
  private async reserve(home: string): Promise<boolean> {
    for (;;) {
      const holder = this.logins.get(home);
      if (holder === undefined) { this.logins.set(home, null); return true; }
      if (holder === null || await this.holds(holder)) return false;
      if (this.logins.get(home) === holder) { this.logins.delete(home); this.save(); }
    }
  }

  /** Names the pid of the login `launching` started, unless its tab has ended already and freed the home. */
  private launched(home: string, launching: LoginHolder, pid: number | null): void {
    if (this.logins.get(home) !== launching) return;
    this.logins.set(home, { pane: launching.pane, pid });
    this.save();
  }

  async handle(request: Request, trackPane?: (paneId: string) => void): Promise<Response> {
    const executableFor = (id: UsageProviderId) => LOGIN[id].binaries.map((cli) => Bun.which(cli, { PATH: this.env["PATH"] ?? "" })).find(Boolean);
    if (request.method === "GET") {
      const id = new URL(request.url).searchParams.get("provider");
      if (id !== null) {
        const provider = USAGE_PROVIDERS.find((provider) => provider.id === id);
        if (!provider) return badRequest("invalid_provider", "Unknown usage provider");
        try {
          const found = await provider.signIns(this.context);
          return jsonResponse({ accounts: found.map((signIn) => signIn.account?.label ?? signIn.account?.id ?? null) });
        } catch (error) { return errorResponse(error); }
      }
      return jsonResponse({ providers: USAGE_PROVIDERS.map(({ id }) => ({
        id, cli: LOGIN[id].cli, installed: Boolean(executableFor(id)), local: LOGIN[id].args !== null,
        separate_home: id === "claude" || id === "codex",
      })) });
    }
    if (request.method !== "POST") return badRequest("method_not_allowed", "Use GET or POST");
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "Request body must be JSON"); }
    const provider = isJsonObject(body) ? USAGE_PROVIDERS.find(({ id }) => id === body["provider"]) : undefined;
    if (!provider || !isJsonObject(body)) return badRequest("invalid_provider", "Unknown usage provider");
    const id = provider.id;
    const separate = id === "claude" || id === "codex";
    // Signing in again names a listed account by its key; its credential home is the server's to find.
    const again = body["account"] !== undefined;
    if (again) {
      // only Claude's and Codex's CLIs sign in to a credential home the server can name
      if (!separate || typeof body["account"] !== "string" || body["account"].length > 256 || body["name"] !== undefined || body["replace"] !== undefined) {
        return badRequest("invalid_account", "Name one account this PC lists to sign in to it again");
      }
    } else if (separate ? typeof body["name"] !== "string" || !/^[a-z0-9-]{1,32}$/.test(body["name"])
      : body["name"] !== undefined || (body["replace"] !== undefined && body["replace"] !== true)) {
      return badRequest("invalid_account_name", "Use 1–32 lowercase letters, numbers or hyphens for the account name");
    }
    const login = LOGIN[id];
    if (login.args === null) return conflictResponse("login_not_supported", "Sign in interactively in Antigravity on the server PC");
    // POSIX exec lets herdr's pane-ended event identify completion, without a second watcher.
    const executable = executableFor(id);
    if (!executable) return conflictResponse("cli_unavailable", "Install the official CLI on this PC before signing in");
    let unusedCredentialHome: string | null = null;
    let reserved: string | null = null;
    // the holder this request set once its tab opened, which only this request may replace or free
    let launching: LoginHolder | null = null;
    try {
      // read from the sign-ins on disk now, not a cached report: a home may hold another account since
      const found = again && typeof body["account"] === "string" ? await localSignInPlace(this.context, body["account"]) : null;
      if (again && found?.provider !== id) {
        return jsonResponse({ error: { code: "account_not_found", message: "This PC no longer lists that account. Refresh and try again." } }, 404);
      }
      if (found && "ambiguous" in found) {
        return conflictResponse("account_ambiguous", "This account is signed in in more than one credential folder on this PC, so Ovis cannot tell which one to renew. Sign in again from a terminal in the folder you want.");
      }
      const place = found;
      if (!separate && !again && body["replace"] !== true && (await provider.signIns(this.context)).length > 0) {
        return conflictResponse("account_confirmation_required", "Confirm before signing in again to this provider");
      }
      // the home the CLI will write: the account's own, a new named one, or the provider's only one
      let loginHome: string;
      try {
        loginHome = place ? `${id}:${canonicalPath(place.home.kind === "dir" ? place.home.dir : join(this.home, id === "claude" ? ".claude" : ".codex"))}`
          : separate ? `${id}:${canonicalPath(join(this.home, `.${id}-${body["name"]}`))}` : id;
      } catch (error) {
        console.warn("Could not tell which credential home a sign-in would write", error);
        return conflictResponse("credential_home_unreadable", "Ovis cannot read this account's credential folder, so it cannot tell whether a sign-in is already running there. Check the folder's permissions on the server PC.");
      }
      if (!await this.reserve(loginHome)) {
        return conflictResponse("login_in_progress", "A sign-in to this account is already open in a terminal tab. Finish or close it first.");
      }
      reserved = loginHome;
      const help = Bun.spawn([executable, ...(id === "claude" ? ["auth"] : login.args), "--help"], {
        env: this.env, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(10_000),
      });
      const text = await new Response(help.stdout).text();
      const success = await help.exited === 0;
      const manual = id === "claude" && !(success && /\blogin\b/.test(text));
      const device = (id === "codex" || id === "grok") && success && text.includes("--device-auth");
      const args = manual ? [] : [...login.args, ...(device ? ["--device-auth"] : [])];
      // the browser that asked has gone (it gives up after 30 s): open no tab it would not see
      if (request.signal.aborted) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const env: Record<string, string> = { HOME: this.home };
      if (process.platform === "win32") env["USERPROFILE"] = this.home;
      const homeVariable = id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      // the account's own home, where its expired sign-in is replaced; null is the default home
      const againHome = place?.home.kind === "dir" ? place.home.dir : null;
      if (place) {
        if (againHome !== null) env[homeVariable] = againHome;
      } else if (separate) {
        const credentialHome = join(this.home, `.${id}-${body["name"]}`);
        try { mkdirSync(credentialHome, { mode: 0o700 }); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") return conflictResponse("account_exists", "That account name already has a credential home. Choose another name.");
          throw error;
        }
        unusedCredentialHome = credentialHome;
        env[id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = credentialHome;
      }
      if (id === "copilot") env["XDG_CONFIG_HOME"] = this.env["XDG_CONFIG_HOME"] || join(this.home, ".config");
      if (id === "cursor") env["NO_OPEN_BROWSER"] = "1";
      if (id === "copilot" && this.env["GH_CONFIG_DIR"]) env["GH_CONFIG_DIR"] = this.env["GH_CONFIG_DIR"];
      if (id === "opencode") env["XDG_DATA_HOME"] = this.env["XDG_DATA_HOME"] || join(this.home, ".local", "share");
      const snapshot = await sessionSnapshot();
      if (request.signal.aborted) return conflictResponse("request_cancelled", "The sign-in request was cancelled");
      const workspace = snapshot.workspaces[0];
      const options = {
        // a home given as a relative path was found from this server's directory, and means it there
        cwd: againHome !== null && !isAbsolute(againHome) ? process.cwd() : this.home, label: again ? `${id} sign-in again` : `${id} sign-in${separate ? ` · ${body["name"]}` : ""}`, env,
      };
      const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
      const paneId = created.root_pane.pane_id;
      this.panes.add(paneId);
      trackPane?.(paneId);
      // the tab is open: a server started again from here on finds the home taken by it
      launching = { pane: paneId, pid: null };
      this.logins.set(reserved, launching);
      this.save();
      // All variable argv are quoted by the bridge's existing POSIX shell encoder.
      if (process.platform === "win32") {
        const info = await paneProcessInfo(paneId);
        const shell = paneShell(info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
        const command = `${place ? credentialHomePrefix(shell, homeVariable, againHome) : ""}${shellCommandLine(shell, executable, args)}`;
        await paneSendText(paneId, `${command}${shell === "cmd" ? " & exit" : "; exit $LASTEXITCODE"}`);
        unusedCredentialHome = null;
        await paneSendKeys(paneId, ["Enter"]);
        this.launched(reserved, launching, info?.shell_pid ?? null);
      } else {
        await paneSendText(paneId, `${manual ? "printf 'Type /login in Claude to sign in.\\n'; " : ""}exec ${place ? credentialHomePrefix("posix", homeVariable, againHome) : ""}${shellCommandLine("posix", executable, args)}\n`);
        unusedCredentialHome = null;
        // exec keeps the shell's pid for the CLI
        this.launched(reserved, launching, (await paneProcessInfo(paneId).catch(() => undefined))?.shell_pid ?? null);
      }
      // the login runs: the home is its until it exits; a launch that failed before here frees it below
      reserved = null;
      return jsonResponse({
        pane_id: paneId, workspace_id: created.tab.workspace_id, manual, device_auth: device,
      } satisfies UsageLoginStarted);
    } catch (error) {
      if (unusedCredentialHome) {
        try { rmdirSync(unusedCredentialHome); }
        catch (cleanupError) {
          // A CLI may already have written credentials; never remove a nonempty home.
          if (!(cleanupError instanceof Error && "code" in cleanupError
            && ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(String(cleanupError.code)))) {
            console.warn("Could not remove unused sign-in credential home", cleanupError);
          }
        }
      }
      return errorResponse(error);
    } finally {
      // refused, or failed before its login ran: the home is free again, unless its tab ended and another took it since
      if (reserved !== null) {
        const holder = this.logins.get(reserved);
        if (launching === null ? holder === null : holder === launching) { this.logins.delete(reserved); if (launching !== null) this.save(); }
      }
    }
  }
}
