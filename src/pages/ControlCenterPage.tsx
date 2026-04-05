import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import './ControlCenterPage.css';
import AllowlistManager from '../components/AllowlistManager';
import AnswerCard from '../components/AnswerCard';
import { useAuth } from '../context/AuthContext';
import { SignInButton } from '@farcaster/auth-kit';
import { EditProfileModal } from '../components/ProfileEditor/EditProfileModal';
import { Pencil } from 'lucide-react';

const ControlCenterPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, login, isMiniApp } = useAuth();
  const [activeTab, setActiveTab] = useState<'notifications' | 'my-qs' | 'my-answers' | 'requests' | 'allowlists'>('notifications');
  const [showEditProfile, setShowEditProfile] = useState(false);

  if (!isAuthenticated) {
    return (
      <>
        <Header showBack backLabel="Feed" onBack={() => navigate('/questions')} />
        <div className="control-center-page mobile-layout-container login-container">
          <h2>Welcome to Qbase</h2>
          <p>Please sign in to access your control center.</p>
          {isMiniApp ? (
            <button className="login-btn" onClick={login}>Sign in with Farcaster</button>
          ) : (
            <SignInButton />
          )}
        </div>
      </>
    );
  }

  // Mock data (replace with real data fetching later)
  const notifications = [
    { id: 1, text: "artlu answered your question", time: "2h ago" },
    { id: 2, text: "New request from tobi", time: "5h ago" },
    { id: 3, text: "Your answer was upvoted", time: "1d ago" },
  ];

  const myQs = [
    { id: 1, text: "What is the meaning of life?", answers: 42 },
    { id: 2, text: "How to center a div?", answers: 5 },
  ];

  const myAnswers = [
    {
      id: 1,
      author: { name: user?.username || 'user', avatarSeed: user?.username || 'user' },
      questionText: "Best programming language?",
      text: "TypeScript, obviously.",
      likes: 12,
      timestamp: "2h ago"
    },
    {
      id: 2,
      author: { name: user?.username || 'user', avatarSeed: user?.username || 'user' },
      questionText: "Tabs or spaces?",
      text: "Spaces.",
      likes: 8,
      timestamp: "5h ago"
    },
  ];

  const requests = [
    { id: 1, from: "tobi", text: "Can you explain quantum physics?" },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'notifications':
        return (
          <div className="list-container">
            {notifications.map(n => (
              <div key={n.id} className="list-item notification-item">
                <span className="notification-text">{n.text}</span>
                <span className="notification-time">{n.time}</span>
              </div>
            ))}
          </div>
        );
      case 'my-qs':
        return (
          <div className="list-container">
            {myQs.map(q => (
              <div key={q.id} className="list-item question-item" onClick={() => navigate(`/question/${q.id}`)}>
                <span className="question-text">{q.text}</span>
                <span className="question-stats">{q.answers} answers</span>
              </div>
            ))}
          </div>
        );
      case 'my-answers':
        return (
          <div className="list-container">
            {myAnswers.map(a => (
              <div key={a.id} className="list-item answer-item" onClick={() => navigate(`/answer/${a.id}`)}>
                <div className="answer-item-question">{a.questionText}</div>
                <div className="answer-item-text">{a.text}</div>
                <div className="answer-item-meta">
                  <span>{a.likes} likes</span>
                  <span>{a.timestamp}</span>
                </div>
              </div>
            ))}
          </div>
        );
      case 'requests':
        return (
          <div className="list-container">
            {requests.map(r => (
              <div key={r.id} className="list-item request-item">
                <span className="request-from">From: {r.from}</span>
                <span className="request-text">{r.text}</span>
              </div>
            ))}
          </div>
        );
      case 'allowlists':
        return <AllowlistManager />;
      default:
        return null;
    }
  };

  return (
    <>
      <Header showBack backLabel="Feed" onBack={() => navigate('/questions')} />
      <div className="control-center-page mobile-layout-container">
        <div className="profile-header">
          <div className="profile-avatar large">
            {user?.pfpUrl ? (
              <img src={user.pfpUrl} alt={`${user.username}'s avatar`} />
            ) : (
              <img
                src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || 'user'}`}
                alt={`${user?.username}'s avatar`}
              />
            )}
          </div>
          <div className="profile-info">
            <h2 className="profile-username">{user?.displayName || user?.username}</h2>
            <div className="profile-stats">
              <div className="stat-item">
                <span className="stat-value">51</span>
                <span className="stat-label">Rep</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">12</span>
                <span className="stat-label">Qs</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">48</span>
                <span className="stat-label">As</span>
              </div>
            </div>
          </div>
          <button
            className="edit-profile-btn"
            onClick={() => setShowEditProfile(true)}
            title="Edit profile"
          >
            <Pencil size={16} />
          </button>
        </div>

        {/* Linked accounts */}
        <div className="linked-accounts">
          {user?.fid ? (
            <div className="linked-account fc-linked">
              <span className="linked-account-label">Farcaster</span>
              <span className="linked-account-value">@{user.username || user?.displayName || 'linked'}</span>
            </div>
          ) : (
            <div className="linked-account fc-not-linked">
              <span className="linked-account-label">Farcaster</span>
              <span className="linked-account-value">Not connected</span>
            </div>
          )}
          <div className="linked-account">
            <span className="linked-account-label">Quilibrium DID</span>
            <span className="linked-account-value">
              {user?.passkeyAddress 
                ? `${user.passkeyAddress.substring(0, 6)}...${user.passkeyAddress.slice(-4)}`
                : 'Not set up'}
            </span>
          </div>
        </div>

        <div className="control-tabs">
          <button
            className={`tab-btn ${activeTab === 'notifications' ? 'active' : ''}`}
            onClick={() => setActiveTab('notifications')}
          >
            Notifications
          </button>
          <button
            className={`tab-btn ${activeTab === 'my-qs' ? 'active' : ''}`}
            onClick={() => setActiveTab('my-qs')}
          >
            My Qs
          </button>
          <button
            className={`tab-btn ${activeTab === 'my-answers' ? 'active' : ''}`}
            onClick={() => setActiveTab('my-answers')}
          >
            My Answers
          </button>
          <button
            className={`tab-btn ${activeTab === 'requests' ? 'active' : ''}`}
            onClick={() => setActiveTab('requests')}
          >
            Requests
          </button>
          <button
            className={`tab-btn ${activeTab === 'allowlists' ? 'active' : ''}`}
            onClick={() => setActiveTab('allowlists')}
          >
            Allowlists
          </button>
        </div>

        <div className="control-content">
          {renderContent()}
        </div>
      </div>
      <EditProfileModal isOpen={showEditProfile} onClose={() => setShowEditProfile(false)} />
    </>
  );
};

export default ControlCenterPage;
