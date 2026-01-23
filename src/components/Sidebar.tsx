import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import './Sidebar.css';

interface SidebarProps {
  scrollWithPage?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ scrollWithPage = false }) => {
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
    <aside className={`sidebar ${scrollWithPage ? 'sidebar-scroll' : ''}`}>
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
