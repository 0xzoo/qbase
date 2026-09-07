import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import ScrollToTop from './components/ScrollToTop';
import DevOnlyRoute from './components/DevOnlyRoute';
import LoadingAnimation from './components/LoadingAnimation';
import { AuthKitProvider } from '@farcaster/auth-kit';
import '@farcaster/auth-kit/styles.css';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';

import { PasskeySignInModal } from './components/PasskeySignInModal';

// Lazy load all pages for better code splitting
const AskPage = lazy(() => import('./pages/AskPage'));
const LandingV2 = lazy(() => import('./pages/LandingV2'));
const HomePage = lazy(() => import('./pages/Home'));
const QuestionsPage = lazy(() => import('./pages/QuestionsPage'));
const AnswersPage = lazy(() => import('./pages/AnswersPage'));
const QuizzesPage = lazy(() => import('./pages/QuizzesPage'));
const MyQuizAnswersPage = lazy(() => import('./pages/MyQuizAnswersPage'));
const MyQuizReportPage = lazy(() => import('./pages/MyQuizReportPage'));
const QuestionPage = lazy(() => import('./pages/QuestionPage'));
const QuestionResultsPage = lazy(() => import('./pages/QuestionResultsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AnswerPage = lazy(() => import('./pages/AnswerPage'));

const QQPage = lazy(() => import('./pages/QQPage'));
const StakePage = lazy(() => import('./pages/StakePage'));
const QuizCreationPage = lazy(() => import('./pages/QuizCreationPage'));
const PollCreationPage = lazy(() => import('./pages/PollCreationPage'));
const TokenomicsDashboardPage = lazy(() => import('./pages/TokenomicsDashboardPage'));
const TaxonomyTestPage = lazy(() => import('./pages/TaxonomyTestPage'));
const BetaWhitelistPage = lazy(() => import('./pages/BetaWhitelistPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const AllowlistsPage = lazy(() => import('./pages/AllowlistsPage'));
const TopicsPage = lazy(() => import('./pages/TopicsPage'));
const TopicDetailPage = lazy(() => import('./pages/TopicDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const BackroomPage = lazy(() => import('./pages/BackroomPage'));
const BartletUnlock = lazy(() => import('./pages/BartletUnlock'));
const ValuesResult = lazy(() => import('./pages/ValuesResult'));
const ApperceptionResult = lazy(() => import('./pages/ApperceptionResult'));
const CASlateResult = lazy(() => import('./pages/CASlateResult'));
const ValuesExport = lazy(() => import('./pages/ValuesExport'));
const ConnectPage = lazy(() => import('./pages/ConnectPage'));
const SharePage = lazy(() => import('./pages/SharePage'));
const QuizPage = lazy(() => import('./pages/QuizPage'));

// Dynamic domain based on environment
// IMPORTANT: Must match server's HOSTNAME env var exactly (no port numbers)
const domain = typeof window !== 'undefined'
  ? window.location.hostname  // Use .hostname instead of .host to exclude port
  : 'qbase.tech';

const siweUri = typeof window !== 'undefined'
  ? window.location.origin
  : 'https://qbase.tech';

const config = {
  rpcUrl: 'https://mainnet.optimism.io',
  domain,
  siweUri,
  relay: 'https://relay.farcaster.xyz',
  statement: 'Sign in to qbase',
};


function App() {
  return (
    <AuthKitProvider config={config}>
      <AuthProvider>
          <SettingsProvider>
            <PasskeySignInModal />
            <Router>
              <Suspense fallback={<LoadingAnimation />}>
              <div className="antialiased">
                <ScrollToTop />
                  <Routes>
                    <Route path="/" element={<LandingV2 />} />
                    <Route path="/home" element={<HomePage />} />
                    <Route path="/ask" element={<AskPage />} />
                    <Route path="/landing" element={<LandingV2 />} />
                    <Route path="/questions" element={<QuestionsPage />} />
                    <Route path="/answers" element={<AnswersPage />} />
                    <Route path="/quizzes" element={<QuizzesPage />} />
                    <Route path="/me/answers" element={<MyQuizAnswersPage />} />
                    <Route path="/me/report" element={<MyQuizReportPage />} />
                    <Route path="/question/:id" element={<QuestionPage />} />
                    <Route path="/question/:id/results" element={<QuestionResultsPage />} />
                    <Route path="/poll/:pollId/results" element={<QuestionResultsPage />} />
                    <Route path="/ask/:username" element={<ProfilePage />} />

                    <Route path="/qq" element={<QQPage />} />
                    <Route path="/stake" element={<StakePage />} />
                    <Route path="/answer/:answerId" element={<AnswerPage />} />
                    <Route path="/create-quiz" element={<QuizCreationPage />} />
                    <Route path="/create-poll" element={<PollCreationPage />} />
                    <Route path="/admin/tokenomics" element={
                      <DevOnlyRoute>
                        <TokenomicsDashboardPage />
                      </DevOnlyRoute>
                    } />
                    <Route path="/admin/taxonomy-test" element={
                      <DevOnlyRoute>
                        <TaxonomyTestPage />
                      </DevOnlyRoute>
                    } />
                    <Route path="/admin/beta-whitelist" element={<BetaWhitelistPage />} />
                    <Route path="/about" element={<AboutPage />} />

                    <Route path="/notifications" element={<NotificationsPage />} />
                    <Route path="/allowlists" element={<AllowlistsPage />} />
                    <Route path="/topics" element={<TopicsPage />} />
                    <Route path="/topics/:name" element={<TopicDetailPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/backroom" element={<BackroomPage />} />
                    <Route path="/bartlet/unlock" element={<BartletUnlock />} />
                    <Route path="/values/result" element={<ValuesResult />} />
                    <Route path="/apperception/result" element={<ApperceptionResult />} />
                    <Route path="/ca-slate/result" element={<CASlateResult />} />
                    <Route path="/values/export" element={<ValuesExport />} />
                    <Route path="/connect" element={<ConnectPage />} />
                    <Route path="/share" element={<SharePage />} />
                    {/* Browser quiz UI for the three Farcaster snap quizzes. */}
                    <Route path="/quiz/:slug" element={<QuizPage />} />
                    {/* Snap URLs are content-negotiated by the worker: snap
                        clients get JSON, crawlers get OG-tagged HTML. When a
                        browser actually executes the SPA shell, redirect to
                        the quiz UI so the link is takeable in-app. */}
                    <Route path="/snap/apperception" element={<Navigate to="/quiz/apperception" replace />} />
                    <Route path="/snap/values" element={<Navigate to="/quiz/values" replace />} />
                    <Route path="/snap/bartlet" element={<Navigate to="/quiz/bartlet" replace />} />
                    {/* /snap/quizzes is the in-feed menu snap. When a browser
                        actually executes the SPA shell (after the worker's
                        HTML representation loads), bounce to the /quizzes
                        landing — same content, takeable in-browser. */}
                    <Route path="/snap/quizzes" element={<Navigate to="/quizzes" replace />} />
                    <Route path="/dev/passkey-test" element={
                      <DevOnlyRoute>
                        <PasskeyTestPage />
                      </DevOnlyRoute>
                    } />
                    <Route path="/dev/passkey-raw" element={
                      <DevOnlyRoute>
                        <PasskeyTestRaw />
                      </DevOnlyRoute>
                    } />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </div>
              </Suspense>
            </Router>
          </SettingsProvider>
      </AuthProvider>
    </AuthKitProvider>
  );
}

// Dev test routes for passkey auth
const PasskeyTestPage = lazy(() => import('./pages/PasskeyTest'));
const PasskeyTestRaw = lazy(() => import('./pages/PasskeyTestRaw'));

export default App;
