/**
 * NotificationsPage - User Notifications
 * 
 * Displays notifications for:
 * - Answers to your questions
 * - Likes on your answers
 * - New followers (future)
 * - System notifications
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, MessageCircle, Heart, UserPlus, Megaphone, Check, Trash2 } from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../context/AuthContext';
import LoadingAnimation from '../components/LoadingAnimation';
import './NotificationsPage.css';

interface Notification {
  id: string;
  type: 'answer' | 'like' | 'follow' | 'system';
  title: string;
  message: string;
  link?: string;
  read: boolean;
  created_at: string;
}

const NotificationsPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  // TODO: Replace with actual API call
  useEffect(() => {
    const fetchNotifications = async () => {
      setLoading(true);
      // Simulating API call - replace with real endpoint
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Mock empty state for now
      setNotifications([]);
      setLoading(false);
    };

    if (isAuthenticated) {
      fetchNotifications();
    } else {
      setLoading(false);
    }
  }, [isAuthenticated]);

  const getNotificationIcon = (type: Notification['type']) => {
    switch (type) {
      case 'answer':
        return <MessageCircle size={18} />;
      case 'like':
        return <Heart size={18} />;
      case 'follow':
        return <UserPlus size={18} />;
      case 'system':
        return <Megaphone size={18} />;
      default:
        return <Bell size={18} />;
    }
  };

  const getNotificationColor = (type: Notification['type']) => {
    switch (type) {
      case 'answer':
        return 'notification-answer';
      case 'like':
        return 'notification-like';
      case 'follow':
        return 'notification-follow';
      case 'system':
        return 'notification-system';
      default:
        return '';
    }
  };

  const handleNotificationClick = (notification: Notification) => {
    // Mark as read
    setNotifications(prev =>
      prev.map(n => n.id === notification.id ? { ...n, read: true } : n)
    );
    
    // Navigate if there's a link
    if (notification.link) {
      navigate(notification.link);
    }
  };

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const filteredNotifications = filter === 'unread' 
    ? notifications.filter(n => !n.read)
    : notifications;

  const unreadCount = notifications.filter(n => !n.read).length;

  if (!isAuthenticated) {
    return (
      <div className="notifications-page">
        <Header title="Notifications" />
        <div className="notifications-container notifications-unauthenticated">
          <div className="notifications-empty-icon">
            <Bell size={48} />
          </div>
          <h2>Sign in to see your notifications</h2>
          <p>Get notified when someone answers your questions or interacts with your content.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="notifications-page">
      <Header title="Notifications" />
      
      <div className="notifications-container">
        {/* Header */}
        <div className="notifications-header">
          <div className="notifications-title-row">
            <div className="notifications-icon">
              <Bell size={24} />
              {unreadCount > 0 && (
                <span className="notifications-badge">{unreadCount}</span>
              )}
            </div>
            <h1>Notifications</h1>
          </div>

          {notifications.length > 0 && (
            <div className="notifications-actions">
              <button onClick={markAllAsRead} className="notifications-action-btn">
                <Check size={16} />
                <span>Mark all read</span>
              </button>
              <button onClick={clearAll} className="notifications-action-btn danger">
                <Trash2 size={16} />
                <span>Clear all</span>
              </button>
            </div>
          )}
        </div>

        {/* Filter Tabs */}
        {notifications.length > 0 && (
          <div className="notifications-filters">
            <button 
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button 
              className={`filter-btn ${filter === 'unread' ? 'active' : ''}`}
              onClick={() => setFilter('unread')}
            >
              Unread {unreadCount > 0 && `(${unreadCount})`}
            </button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="notifications-loading">
            <LoadingAnimation variant="spinner" size="md" />
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="notifications-empty">
            <div className="notifications-empty-visual">
              <Bell size={40} />
            </div>
            <h3>
              {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
            </h3>
            <p>
              {filter === 'unread' 
                ? "You're all caught up!"
                : "When someone answers your questions or interacts with your content, you'll see it here."}
            </p>
          </div>
        ) : (
          <div className="notifications-list">
            {filteredNotifications.map((notification) => (
              <div
                key={notification.id}
                className={`notification-item ${notification.read ? 'read' : 'unread'} ${getNotificationColor(notification.type)}`}
                onClick={() => handleNotificationClick(notification)}
              >
                <div className="notification-icon-wrapper">
                  {getNotificationIcon(notification.type)}
                </div>
                <div className="notification-content">
                  <div className="notification-title">{notification.title}</div>
                  <div className="notification-message">{notification.message}</div>
                  <div className="notification-time">
                    {new Date(notification.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
                {!notification.read && <div className="notification-unread-dot" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default NotificationsPage;

