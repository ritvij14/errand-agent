// The shared error catalogue (2.5.3): every HTTP error is { error, code, details? }
// with its proper status — never a raw stack trace. Conversation-level codes live in
// the design's catalogue table; HTTP-level ones here.
export const HTTP_ERRORS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  NO_SUCH_USERNAME: 401,
  WRONG_PASSWORD: 401,
  RATE_LIMITED: 429,
  CONVERSATION_BUSY: 409,
} as const satisfies Record<string, number>;

export type HttpErrorCode = keyof typeof HTTP_ERRORS;

import type { Response } from "express";

// The single place an HTTP error response is produced.
export const sendError = (res: Response, code: HttpErrorCode, message: string, details?: Record<string, string>): void => {
  res.status(HTTP_ERRORS[code]).json(details ? { error: message, code, details } : { error: message, code });
};

export const sendUnknownError = (res: Response): void => {
  res.status(500).json({ error: "Something went wrong on our side.", code: "unknown_error" });
};