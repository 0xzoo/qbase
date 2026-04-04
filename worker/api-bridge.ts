/**
 * Bridge file: re-exports src/api/ handlers for use by worker/routes/
 * The Cloudflare vite plugin resolves worker imports relative to worker/,
 * so route files can't directly import from ../../src/. This bridge
 * sits in worker/ and can reach ../src/.
 */
export {
  handleCreateAnswer,
  handleGetAnswer,
  handleListAnswers,
  handleGetUserAnswers,
  handleUpdateAnswer,
  handleListAllAnswers,
} from '../src/api/answers';

export {
  handleCreateQuery,
  handleGetQuery,
  handleListQueries,
} from '../src/api/queries';

export { handleAllowlistRoutes } from '../src/api/allowlists';
