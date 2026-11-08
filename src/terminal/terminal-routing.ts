export function isSshAuthenticationFailure(message: string): boolean {
  return /permission denied\s*\([^\r\n)]*(?:publickey|password|keyboard-interactive)|authentication (?:methods failed|failed)|no supported authentication methods|agent refused operation|sign_and_send_pubkey.*signing failed|认证失败/i.test(message);
}
