import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import FeedPage from './pages/FeedPage';
import QuestionPage from './pages/QuestionPage';
import ProfilePage from './pages/ProfilePage';
import AnswerPage from './pages/AnswerPage';
import ControlCenterPage from './pages/ControlCenterPage';
import QQPage from './pages/QQPage';
import './App.css';
import LandingPage from './pages/LandingPage';
import QuizCreationPage from './pages/QuizCreationPage';
import TokenomicsDashboardPage from './pages/TokenomicsDashboardPage';
import NotFoundPage from './pages/NotFoundPage';
import AboutPage from './pages/AboutPage';
import TaxonomyTestPage from './pages/TaxonomyTestPage';
import ScrollToTop from './components/ScrollToTop';
import DevOnlyRoute from './components/DevOnlyRoute';
import { AuthKitProvider } from '@farcaster/auth-kit';
import '@farcaster/auth-kit/styles.css';
import { AuthProvider } from './context/AuthContext';

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
        <Router>
          <ScrollToTop />
          <div className="app-container">
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/questions" element={<FeedPage />} />
              <Route path="/answers" element={<FeedPage />} />
              <Route path="/quizzes" element={<FeedPage />} />
              <Route path="/question/:id" element={<QuestionPage />} />
              <Route path="/user/:username" element={<ProfilePage />} />
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
              <Route path="/about" element={<AboutPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </div>
        </Router>
      </AuthProvider>
    </AuthKitProvider>
  );
}

export default App;
