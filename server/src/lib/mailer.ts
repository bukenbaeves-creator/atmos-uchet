import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';

// Почта настроена, только когда есть хост, логин и пароль отправителя.
export function isMailConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}

// Ленивый singleton транспорта — создаём один раз при первой отправке.
let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

interface Attachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
}): Promise<void> {
  if (!isMailConfigured()) {
    throw new Error('Почта не настроена: задайте SMTP_HOST, SMTP_USER, SMTP_PASS в переменных окружения.');
  }
  await getTransporter().sendMail({
    from: config.smtp.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
}
