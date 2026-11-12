const t = (message: string) => message;
import { redactSensitiveText } from '../security/redact'

/** Explain noninteractive credential failures without misclassifying network errors. */
export function describeGitOperationError(error:unknown):string {
    const message=redactSensitiveText(String(error))
    if(!/could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|Cannot prompt because user interactivity has been disabled|could not read from terminal.*(?:device|address)/i.test(message))return message
    if(message.includes('gh auth login')&&message.includes('gh auth setup-git'))return message
    return message+'\n'+t('Git 无法获取登录凭据，插件不能交互输入用户名或密码。如果使用 GitHub HTTPS 地址，请在本机终端依次执行 gh auth login 和 gh auth setup-git，再重试；WSL 工作区请在对应 WSL 环境中执行。其他 Git 服务请配置 credential helper，或使用已配置密钥的 SSH 地址。')
}
