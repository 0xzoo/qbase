import React from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import PollCreationForm from '../components/poll/PollCreationForm';
import './PollCreationPage.css';

const PollCreationPage: React.FC = () => {
  return (
    <div className="poll-creation-page-wrapper">
      <Header showBack backLabel="Back" title="Create Poll" />
      <Sidebar />
      <div className="mobile-layout-container">
        <div className="poll-creation-page">
          <PollCreationForm navigateOnSuccess={true} />
        </div>
      </div>
    </div>
  );
};

export default PollCreationPage;
