import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './App.css';
import ScrollToTop from './components/ScrollToTop';
import DevOnlyRoute from './components/DevOnlyRoute';
import LoadingAnimation from './components/LoadingAnimation';
import { AuthKitProvider } from '@farcaster/auth-kit';
import '@farcaster/auth-kit/styles.css';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';

// Lazy load all pages for better code splitting
const LandingPage = lazy(() => import('./pages/LandingPage'));
const AskPage = lazy(() => import('./pages/AskPage'));
const NewLandingPage = lazy(() => import('./pages/NewLandingPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const FeedPage = lazy(() => import('./pages/FeedPage'));
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
        <SettingsProvider>
          <Router>
            <ScrollToTop />
            <div className="app-container">
              <Suspense fallback={<LoadingFallback />}>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/ask" element={<AskPage />} />
                  <Route path="/landing" element={<NewLandingPage />} />
                  <Route path="/home" element={<HomePage />} />
                  <Route path="/questions" element={<FeedPage />} />
                  <Route path="/answers" element={<FeedPage />} />
                  <Route path="/quizzes" element={<FeedPage />} />
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
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </div>
          </Router>
        </SettingsProvider>
      </AuthProvider>
    </AuthKitProvider>
  );
}

export default App;
