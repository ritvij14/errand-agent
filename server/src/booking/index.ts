// Public API of booking operations (§ 2.5.6).
export { operationRepo, type OperationRecord } from "./operation.repo.js";
export { authorizeWrite, startBookOperation, type BookRequest } from "./gates.js";
export { executeBook, MAX_BOOK_ATTEMPTS, type BookOutcome, type BookTools } from "./execute.js";
