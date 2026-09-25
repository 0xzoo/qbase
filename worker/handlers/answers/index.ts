// Barrel for the answers handler family (split by request shape).

export { handleCreateAnswer } from './create';
export {
  handleGetAnswer,
  handleListAnswers,
  handleListUserAnswersForQuery,
  handleGetUserAnswers,
  handleListAllAnswers,
  handleListMyAnswersForQuery,
} from './read';
export { handleUpdateAnswer, handleDeleteAnswer } from './mutate';
