// Public API of booking operations (§ 2.5.6).
export { operationRepo, type OperationRecord } from "./operation.repo.js";
export {
  authorizeWrite,
  startBookOperation,
  startCancelOperation,
  startRescheduleOperation,
  type BookRequest,
} from "./gates.js";
export {
  executeBook,
  executeCancel,
  executeReschedule,
  MAX_BOOK_ATTEMPTS,
  type BookOutcome,
  type BookTools,
  type CancelOutcome,
  type CancelTools,
  type RescheduleOutcome,
  type RescheduleTools,
} from "./execute.js";
