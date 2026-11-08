/** Adapted from Tabby's AutoSudoPasswordMiddleware (MIT), with incremental
 * prompt parsing and explicit user matching. See third-party/Tabby-MIT.txt. */
const SUDO_PROMPT_PATTERNS: RegExp[] = [
  // Traditional sudo patterns (with username)
  // English: [sudo] password for username:
  /^\[sudo\] password for ([^:]+):\s*$/im,
  // German: [sudo] Passwort für username:
  /^\[sudo\] Passwort für ([^:]+):\s*$/im,
  // French: [sudo] Mot de passe de username :
  /^\[sudo\] Mot de passe de ([^:]+)\s+:\s*$/im,
  // Spanish: [sudo] contraseña para username:
  /^\[sudo\] [Cc]ontraseña para ([^:]+):\s*$/im,
  // Portuguese: [sudo] senha para username:
  /^\[sudo\] [Ss]enha para ([^:]+):\s*$/im,
  // Italian: [sudo] password di username:
  /^\[sudo\] [Pp]assword di ([^:]+):\s*$/im,
  // Simplified Chinese: [sudo] username 的密码：
  /^\[sudo\] ([^\s]+) 的密码[：:]\s*$/im,
  // Traditional Chinese: [sudo] username 的密碼：
  /^\[sudo\] ([^\s]+) 的密碼[：:]\s*$/im,
  // Japanese: [sudo] username のパスワード:
  /^\[sudo\] ([^\s]+) のパスワード[：:]\s*$/im,
  // Korean: [sudo] username 암호:
  /^\[sudo\] ([^\s]+) 암호[：:]\s*$/im,
  // Russian: [sudo] пароль для username:
  /^\[sudo\] пароль для ([^:]+):\s*$/im,
  // Polish: [sudo] hasło użytkownika username:
  /^\[sudo\] hasło użytkownika ([^:]+):\s*$/im,
  // Turkish: [sudo] username için parola:
  /^\[sudo\] ([^\s]+) için parola:\s*$/im,
  // Czech: [sudo] heslo pro username:
  /^\[sudo\] [Hh]eslo pro ([^:]+):\s*$/im,
  // Swedish: [sudo] lösenord för username:
  /^\[sudo\] lösenord för ([^:]+):\s*$/im,
  // Danish: [sudo] adgangskode for username:
  /^\[sudo\] adgangskode for ([^:]+):\s*$/im,
  // Indonesian: [sudo] kata sandi untuk username:
  /^\[sudo\] kata sandi untuk ([^:]+):\s*$/im,
  // Ukrainian: [sudo] пароль до username:
  /^\[sudo\] пароль до ([^:]+):\s*$/im,
  // Croatian: [sudo] lozinka za username:
  /^\[sudo\] lozinka za ([^:]+):\s*$/im,

  // sudo-rs pattern (no username displayed, use empty capture group)
  // Matches: [sudo: authenticate] <password word>:
  /^\[sudo: authenticate\] .+?[：:]\s*$/im
];

export class SudoPasswordMiddleware {
  private tail = '';
  private pending = false;
  private epoch = 0;
  constructor(
    private readonly user: string,
    private readonly loadPassword: () => Promise<string | undefined>,
    private readonly hint: () => void
  ) {}
  feedOutput(data: string): void {
    this.epoch++;
    this.tail = (this.tail + data).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-2048);
    const line = this.tail.split(/[\r\n]/).at(-1) ?? '';
    const match = SUDO_PROMPT_PATTERNS.map((p) => p.exec(line)).find(Boolean);
    if (match && (match[1]?.trim() || this.user) === this.user && !this.pending) {
      this.pending = true;
      this.hint();
    } else if (this.pending && (!match || (match[1]?.trim() || this.user) !== this.user))
      this.reset();
  }
  async feedInput(data: string, send: (data: string) => void): Promise<void> {
    const pending = this.pending;
    this.reset();
    const epoch = this.epoch;
    if (pending && data === '\r') {
      const password = await this.loadPassword();
      if (epoch !== this.epoch) return;
      send(password !== undefined ? password + '\n' : data);
    } else send(data);
  }
  reset(): void {
    this.pending = false;
    this.tail = '';
    this.epoch++;
  }
}
