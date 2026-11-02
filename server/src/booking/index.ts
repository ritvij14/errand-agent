// Public API of booking operations (§ 2.5.6).
export { operationRepo, type OperationRecord } from "./operation.repo.js";
export { authorizeWrite, startBookOperation, startCancelOperation, type BookRequest } from "./gates.js";
export {
  executeBook,
  executeCancel,
  MAX_BOOK_ATTEMPTS,
  type BookOutcome,
  type BookTools,
  type CancelOutcome,
  type CancelTools,
} from "./execute.js";
