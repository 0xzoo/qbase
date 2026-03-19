import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import './styles/passkey-modal-overrides.css';
import ScrollToTop from './components/ScrollToTop';
import DevOnlyRoute from './components/DevOnlyRoute';
import LoadingAnimation from './components/LoadingAnimation';
import { AuthKitProvider } from '@farcaster/auth-kit';
import '@farcaster/auth-kit/styles.css';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';
import { NillionKeyProvider } from './context/NillionKeyContext';
import { PasskeysProvider, FQ_APP_PREFIX } from './quilibrium';

// Lazy load all pages for better code splitting
const AskPage = lazy(() => import('./pages/AskPage'));
const NewLandingPage = lazy(() => import('./pages/NewLandingPage'));
const HomePage = lazy(() => import('./pages/Home'));
const QuestionsPage = lazy(() => import('./pages/QuestionsPage'));
const AnswersPage = lazy(() => import('./pages/AnswersPage'));
const QuizzesPage = lazy(() => import('./pages/QuizzesPage'));
const QuestionPage = lazy(() => import('./pages/QuestionPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AnswerPage = lazy(() => import('./pages/AnswerPage'));
const ControlCenterPage = lazy(() => import('./pages/ControlCenterPage'));
const QQPage = lazy(() => import('./pages/QQPage'));
const QuizCreationPage = lazy(() => import('./pages/QuizCreationPage'));
const TokenomicsDashboardPage = lazy(() => import('./pages/TokenomicsDashboardPage'));
const TaxonomyTestPage = lazy(() => import('./pages/TaxonomyTestPage'));
const BetaWhitelistPage = lazy(() => import('./pages/BetaWhitelistPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const VaultPage = lazy(() => import('./pages/VaultPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const AllowlistsPage = lazy(() => import('./pages/AllowlistsPage'));
const TopicsPage = lazy(() => import('./pages/TopicsPage'));
const TopicDetailPage = lazy(() => import('./pages/TopicDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

// Dynamic domain based on environment
// IMPORTANT: Must match server's HOSTNAME env var exactly (no port numbers)
const domain = typeof window !== 'undefined'
  ? window.location.hostname  // Use .hostname instead of .host to exclude port
  : 'qbase.tech';

const siweUri = typeof window !== 'undefined'
  ? window.location.origin
  : 'https://qbase.tech';

const config = {
  rpcUrl: 'https://optimism.drpc.org',
  domain,
  siweUri,
  relay: 'https://relay.farcaster.xyz',
  statement: 'Sign in to qbase',
};


// Loading component for lazy-loaded routes
function LoadingFallback() {
  return <LoadingAnimation variant="full" />;
}

function App() {
  return (
    <AuthKitProvider config={config}>
      <AuthProvider>
        <NillionKeyProvider>
          <SettingsProvider>
            <PasskeysProvider fqAppPrefix={FQ_APP_PREFIX}>
              <Router>
                <Suspense fallback={<LoadingAnimation />}>
                  <div className="antialiased">
                    <ScrollToTop />
                    <Routes>
                      <Route path="/" element={<HomePage />} />
                      <Route path="/ask" element={<AskPage />} />
                      <Route path="/landing" element={<NewLandingPage />} />
                      <Route path="/questions" element={<QuestionsPage />} />
                      <Route path="/answers" element={<AnswersPage />} />
                      <Route path="/quizzes" element={<QuizzesPage />} />
                      <Route path="/question/:id" element={<QuestionPage />} />
                      <Route path="/ask/:username" element={<ProfilePage />} />
                      <Route path="/me" element={<ControlCenterPage />} />
                      <Route path="/qq" element={<QQPage />} />
                      <Route path="/answer/:answerId" element={<AnswerPage />} />
                      <Route path="/create-quiz" element={<QuizCreationPage />} />
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
                      <Route path="/vault" element={<VaultPage />} />
                      <Route path="/notifications" element={<NotificationsPage />} />
                      <Route path="/allowlists" element={<AllowlistsPage />} />
                      <Route path="/topics" element={<TopicsPage />} />
                      <Route path="/topics/:name" element={<TopicDetailPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
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
            </PasskeysProvider>
          </SettingsProvider>
        </NillionKeyProvider>
      </AuthProvider>
    </AuthKitProvider>
  );
}

// Dev test routes for passkey auth
const PasskeyTestPage = lazy(() => import('./pages/PasskeyTest'));
const PasskeyTestRaw = lazy(() => import('./pages/PasskeyTestRaw'));

export default App;
