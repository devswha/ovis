/**
 * "Not me" on the notice's own PC (device table T60; Track A S2-09): the answer goes over that PC's socket, and only
 * that PC's notice-answer-result for this notice id counts as its receipts. A PC that does not offer it, or does not
 * answer in time, is not reached, so the caller retries it with the same blocks.
 */
import type { NoticeAnswer } from "../../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../../shared/protocol.ts";

export interface AnswerSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  sendNotice(message: NoticeAnswer): boolean;
}

export function answerOnPc(socket: AnswerSocket, answer: NoticeAnswer, timeoutMs: number): Promise<readonly unknown[]> {
  return new Promise((resolve, reject) => {
    const off = socket.on((message) => {
      const frame = message as { type?: unknown; id?: unknown; receipts?: unknown };
      if (frame.type !== "notice-answer-result" || frame.id !== answer.id || !Array.isArray(frame.receipts)) return;
      clearTimeout(timer);
      off();
      resolve(frame.receipts);
    });
    const timer = setTimeout(() => { off(); reject(new Error("The PC did not answer")); }, timeoutMs);
    if (!socket.sendNotice(answer)) { clearTimeout(timer); off(); reject(new Error("The PC does not take account answers")); }
  });
}
