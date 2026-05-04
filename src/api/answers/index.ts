/**
 * Re-export façade for the answers handler family.
 *
 * The family used to live in a single 1801-line src/api/answers.ts;
 * the handlers split into create / read / mutate by request shape.
 * Existing callers that `import { handleX } from '../src/api/answers'`
 * resolve to this barrel and don't need to change.
 */

export { handleCreateAnswer } from './create';
export {
  handleGetAnswer,
  handleListAnswers,
  handleListUserAnswersForQuery,
  handleGetUserAnswers,
  handleListAllAnswers,
} from './read';
export { handleUpdateAnswer, handleDeleteAnswer } from './mutate';
