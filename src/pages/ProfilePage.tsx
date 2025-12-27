import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import './ProfilePage.css';

const ProfilePage: React.FC = () => {
  const { username } = useParams<{ username: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'qs' | 'as'>('as');

  // Mock data based on the screenshot
  const profile = {
    username: username || 'artlu',
    joinedDate: 'Sat Jul 27 2024',
    avatarSeed: username || 'artlu',
    answers: [
      {
        id: 1,
        question: "what is your relationship with the past?",
        answer: "Fond, but distant. We live in the present"
      },
      {
        id: 2,
        question: "who let the dogs out?",
        answer: "who, who, who, woh"
      },
      {
        id: 3,
        question: "what is your favorite pokemon",
        answer: "Pikachu"
      },
      {
        id: 4,
        question: "what are you wearing",
        answer: "I'll tell you what I'm not wearing - pants!"
      },
      {
        id: 5,
        question: "how often do you report a cast",
        answer: "never"
      },
      {
        id: 6,
        question: "what do you believe in?",
        answer: "God made man in His own image"
      }
    ],
    questions: [
      {
        id: 1,
        question: "what is your favorite color?",
      },
      {
        id: 2,
        question: "where do you see yourself in 5 years?",
      }
    ]
  };

  return (
    <>
      <Header showBack />
      <div className="profile-page mobile-layout-container">
        <div className="profile-header">
          <div className="profile-avatar">
            <img
              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${profile.avatarSeed}`}
              alt={`${profile.username}'s avatar`}
            />
          </div>
          <div className="profile-info">
            <h2 className="profile-username">{profile.username}</h2>
            <span className="profile-joined">joined {profile.joinedDate}</span>
          </div>
        </div>

        <div className="profile-tabs">
          <button
            className={`tab-btn ${activeTab === 'qs' ? 'active' : ''}`}
            onClick={() => setActiveTab('qs')}
          >
            qs
          </button>
          <button
            className={`tab-btn ${activeTab === 'as' ? 'active' : ''}`}
            onClick={() => setActiveTab('as')}
          >
            as
          </button>
        </div>

        <div className="profile-content">
          {activeTab === 'as' ? (
            <div className="answers-list">
              {profile.answers.map((item) => (
                <div
                  key={item.id}
                  className="qa-item clickable"
                  onClick={() => navigate(`/answer/${item.id}`, {
                    state: {
                      questionText: item.question,
                      answerText: item.answer,
                      authorName: profile.username,
                      date: profile.joinedDate // Using joined date as placeholder or we could add date to mock
                    }
                  })}
                >
                  <div className="qa-question">{item.question}</div>
                  <div className="qa-answer">{item.answer}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="questions-list">
              {profile.questions.map((item) => (
                <div key={item.id} className="qa-item">
                  <div className="qa-question">{item.question}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ProfilePage;
