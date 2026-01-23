import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import './Sidebar.css';

const Sidebar: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = [
    { path: '/home', label: 'home' },
    { path: '/questions', label: 'questions' },
    { path: '/answers', label: 'answers' },
    { path: '/topics', label: 'topics' },
    { path: '/quizzes', label: 'quizzes' },
    { path: '/about', label: 'about' },
  ];

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <span
            key={item.path}
            className={`sidebar-link ${location.pathname === item.path ? 'active' : ''}`}
            onClick={() => navigate(item.path)}
          >
            {item.label}
          </span>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
