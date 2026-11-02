import { Router } from "express";
import { chatService } from "./chat.service.js";

export const chatRouter = Router();

// Scaffold stub — replaced as the chat-sessions and agent-core features are built.
chatRouter.post("/chat", (req, res) => {
  const message = req.body?.message;
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({
      error: "Field 'message' is required and must be a non-empty string",
      code: "VALIDATION_ERROR",
    });
  }
  const session = chatService.append(message);
  res.status(200).json(session);
});
