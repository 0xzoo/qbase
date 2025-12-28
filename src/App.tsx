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
import { AuthProvider } from './context/AuthContext';

const config = {
  rpcUrl: 'https://mainnet.optimism.io',
  domain: 'qbase.tech',
  siweUri: 'https://qbase.tech/login',
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
              <Route path="/admin/tokenomics" element={<TokenomicsDashboardPage />} />
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
