import type { EmailMessage } from "./email.types.js";

/**
 * Message templates.
 *
 * Plain, quiet, and free of marketing. A verification email that looks like an
 * advert is the one people ignore or mark as spam — and a domain that collects
 * spam complaints stops delivering the mail that actually matters.
 *
 * Everything interpolated here is either our own copy or a value the server
 * generated. Anything originating from a person is escaped first.
 */

const BRAND = "#0C4DA1";

/** Names and admin-written reasons land inside HTML, so they are escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** First name only, matching how the product addresses people everywhere. */
function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return escapeHtml(first && first.length > 0 ? first : "there");
}

function layout(body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;">',
    '  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">',
    `    <div style="font-size:18px;font-weight:700;color:${BRAND};margin-bottom:24px;">GoSaath</div>`,
    body,
    '    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e6e8eb;font-size:12px;color:#6b7280;line-height:1.5;">',
    "      GoSaath helps students and faculty share the commute they already make.",
    "      If you did not expect this email, you can ignore it.",
    "    </div>",
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n");
}

function codeBlock(code: string): string {
  return [
    '    <div style="margin:24px 0;padding:16px;background:#f6f7f9;border-radius:8px;text-align:center;">',
    `      <div style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace;color:#1a1d21;">${escapeHtml(code)}</div>`,
    "    </div>",
  ].join("\n");
}

export function verificationCodeEmail(input: {
  name: string;
  code: string;
  expiresInMinutes: number;
}): Omit<EmailMessage, "to"> {
  const who = firstName(input.name);
  return {
    // No code in the subject: subjects render on a lock screen, and a code
    // readable without unlocking the phone defeats the point of having one.
    subject: "Confirm your GoSaath account",
    tag: "verification",
    html: layout(
      [
        '    <div style="font-size:16px;line-height:1.6;">',
        `      <p style="margin:0 0 16px;">Hi ${who},</p>`,
        '      <p style="margin:0 0 8px;">Enter this code in the app to confirm your institution email.</p>',
        "    </div>",
        codeBlock(input.code),
        '    <div style="font-size:14px;line-height:1.6;color:#4b5563;">',
        `      <p style="margin:0 0 8px;">The code expires in ${input.expiresInMinutes} minutes.</p>`,
        '      <p style="margin:0;">If you did not try to create an account, somebody may have mistyped their address. You can ignore this — no account is created until the code is entered.</p>',
        "    </div>",
      ].join("\n"),
    ),
    text: [
      `Hi ${who},`,
      "",
      "Enter this code in the app to confirm your institution email:",
      "",
      `    ${input.code}`,
      "",
      `The code expires in ${input.expiresInMinutes} minutes.`,
      "",
      "If you did not try to create an account, you can ignore this email.",
      "No account is created until the code is entered.",
    ].join("\n"),
  };
}

export function passwordResetEmail(input: {
  name: string;
  code: string;
  expiresInMinutes: number;
}): Omit<EmailMessage, "to"> {
  const who = firstName(input.name);
  return {
    subject: "Reset your GoSaath password",
    tag: "password-reset",
    html: layout(
      [
        '    <div style="font-size:16px;line-height:1.6;">',
        `      <p style="margin:0 0 16px;">Hi ${who},</p>`,
        '      <p style="margin:0 0 8px;">Use this code to set a new password.</p>',
        "    </div>",
        codeBlock(input.code),
        '    <div style="font-size:14px;line-height:1.6;color:#4b5563;">',
        `      <p style="margin:0 0 8px;">The code expires in ${input.expiresInMinutes} minutes.</p>`,
        '      <p style="margin:0;"><strong>If you did not ask to reset your password</strong>, ignore this email. Your password has not changed, and nobody can reset it without this code.</p>',
        "    </div>",
      ].join("\n"),
    ),
    text: [
      `Hi ${who},`,
      "",
      "Use this code to set a new password:",
      "",
      `    ${input.code}`,
      "",
      `The code expires in ${input.expiresInMinutes} minutes.`,
      "",
      "If you did not ask to reset your password, ignore this email.",
      "Your password has not changed, and nobody can reset it without this code.",
    ].join("\n"),
  };
}

export function existingAccountEmail(input: {
  name: string;
}): Omit<EmailMessage, "to"> {
  const who = firstName(input.name);
  return {
    subject: "You already have a GoSaath account",
    tag: "existing-account",
    html: layout(
      [
        '    <div style="font-size:16px;line-height:1.6;">',
        `      <p style="margin:0 0 16px;">Hi ${who},</p>`,
        '      <p style="margin:0 0 8px;">Somebody just tried to create a GoSaath account with this address, but you already have one. No new account was made and nothing has changed.</p>',
        '      <p style="margin:0 0 8px;">If that was you, sign in instead. If you have forgotten your password, use <strong>Forgot your password</strong> on the sign-in screen.</p>',
        '      <p style="margin:16px 0 0;">If it was not you, you can safely ignore this — somebody likely mistyped their own address.</p>',
        "    </div>",
      ].join("\n"),
    ),
    text: [
      `Hi ${who},`,
      "",
      "Somebody just tried to create a GoSaath account with this address, but",
      "you already have one. No new account was made and nothing has changed.",
      "",
      "If that was you, sign in instead. If you have forgotten your password,",
      "use Forgot your password on the sign-in screen.",
      "",
      "If it was not you, you can safely ignore this — somebody likely",
      "mistyped their own address.",
    ].join("\n"),
  };
}

export function badgeDecisionEmail(input: {
  name: string;
  approved: boolean;
  reason?: string;
}): Omit<EmailMessage, "to"> {
  const who = firstName(input.name);

  if (input.approved) {
    return {
      subject: "Your GoSaath badge is approved",
      tag: "badge",
      html: layout(
        [
          '    <div style="font-size:16px;line-height:1.6;">',
          `      <p style="margin:0 0 16px;">Hi ${who},</p>`,
          '      <p style="margin:0 0 8px;">Your verified badge has been approved. It now shows beside your name to others at your campus.</p>',
          "    </div>",
        ].join("\n"),
      ),
      text: [
        `Hi ${who},`,
        "",
        "Your verified badge has been approved.",
        "It now shows beside your name to others at your campus.",
      ].join("\n"),
    };
  }

  // Admin-written, so escaped like any other human input.
  const reason = input.reason
    ? `      <p style="margin:0 0 8px;">${escapeHtml(input.reason)}</p>`
    : "";

  return {
    subject: "About your GoSaath badge request",
    tag: "badge",
    html: layout(
      [
        '    <div style="font-size:16px;line-height:1.6;">',
        `      <p style="margin:0 0 16px;">Hi ${who},</p>`,
        '      <p style="margin:0 0 8px;">Your badge request was not approved this time.</p>',
        reason,
        '      <p style="margin:16px 0 0;">You can apply again from Profile once that is sorted. The badge is optional — your account works either way.</p>',
        "    </div>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    text: [
      `Hi ${who},`,
      "",
      "Your badge request was not approved this time.",
      ...(input.reason ? ["", input.reason] : []),
      "",
      "You can apply again from Profile.",
      "The badge is optional — your account works either way.",
    ].join("\n"),
  };
}
