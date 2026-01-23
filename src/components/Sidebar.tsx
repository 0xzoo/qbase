import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import './Sidebar.css';

const Sidebar: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = [
    { path: '/home', label: 'Home' },
    { path: '/questions', label: 'Questions' },
    { path: '/answers', label: 'Answers' },
    { path: '/topics', label: 'Topics' },
    { path: '/quizzes', label: 'Quizzes' },
    { path: '/about', label: 'About' },
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
