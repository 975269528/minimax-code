import { QueueServiceError } from '../../service/session-system/index.js';
import { ApplicationError } from './errors.js';

export function queueServiceApplicationError(error: QueueServiceError): ApplicationError {
  if (error.reason === 'session-not-found') {
    return new ApplicationError(404, 'local_session_not_found', error.message);
  }
  if (error.reason === 'expiry-invalid') {
    return new ApplicationError(400, 'local_queue_expiry_invalid', error.message);
  }
  if (error.reason === 'model-invalid') {
    return new ApplicationError(400, 'VALIDATION_ERROR', error.message);
  }
  if (error.reason === 'data-corrupt') {
    return new ApplicationError(500, 'local_queue_data_corrupt', error.message);
  }
  if (error.reason === 'read-only-session') {
    return new ApplicationError(409, 'read_only_legacy_session', error.message);
  }
  if (error.reason === 'runtime-unsupported') {
    return new ApplicationError(409, 'local_queue_runtime_unsupported', error.message);
  }
  return new ApplicationError(409, 'local_session_busy', error.message);
}
