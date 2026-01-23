
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import {
  ArrowRight,
  Lock,
  EyeOff,
  Network,
  Globe,
  Users,
  Database,
  Bot
} from 'lucide-react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import './AboutPage.css';

const AboutPage: React.FC = () => {
  const navigate = useNavigate();
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const fadeInUp: Variants = {
    hidden: { opacity: 0, y: 30 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: "easeOut" } }
  };

  const staggerContainer: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15
      }
    }
  };

  return (
    <div className="about-page-container" style={{
      '--scroll-progress': Math.min(scrollY / 2000, 1)
    } as React.CSSProperties}>

      {/* Dynamic Background */}
      <div className="about-background" />

      {/* Header Component */}
      <Header title="About" />

      {/* Sidebar Navigation */}
      <Sidebar scrollWithPage={true} />

      <main className="about-main-content">
        {/* Hero Section */}
        <section className="about-hero">
          <motion.div
            className="about-hero-content"
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
          >
            <motion.h1 variants={fadeInUp} className="about-title">
              your social knowledge base
            </motion.h1>
            <motion.p variants={fadeInUp} className="about-subtitle">
              a structured, searchable profile of your opinions, preferences, and interior world. all under your control.
            </motion.p>
          </motion.div>
        </section>

        {/* 1. The Three Actors */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>three actors.<br />one platform.</motion.h2>
              <motion.p variants={fadeInUp}>
                qbase addresses problems for three distinct actors in the data economy.
              </motion.p>
              <motion.div variants={fadeInUp}>
                <p><strong>Individuals:</strong> Your digital identity is fragmented across platforms. Build a personal data store you actually own.</p>
                <p><strong>AI Agents:</strong> Context makes AI useful. Give authorized agents structured access to your preferences and values.</p>
                <p><strong>Society:</strong> The richest data about human beliefs is locked inside corporations. Contribute to collective understanding with your explicit consent.</p>
              </motion.div>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div className="sovereignty-visual">
                <motion.div
                  className="node-center"
                  animate={{ scale: [1, 1.05, 1] }}
                  transition={{ duration: 4, repeat: Infinity }}
                >
                  YOU
                </motion.div>
                {[
                  { icon: <Users size={20} />, label: 'Individual', deg: 0 },
                  { icon: <Bot size={20} />, label: 'AI Agent', deg: 120 },
                  { icon: <Database size={20} />, label: 'Society', deg: 240 }
                ].map((item, i) => (
                  <motion.div
                    key={i}
                    className="node-satellite"
                    style={{
                      top: '50%',
                      left: '50%',
                    }}
                    animate={{
                      x: [Math.cos(item.deg * Math.PI / 180) * 100, Math.cos((item.deg + 360) * Math.PI / 180) * 100],
                      y: [Math.sin(item.deg * Math.PI / 180) * 100, Math.sin((item.deg + 360) * Math.PI / 180) * 100],
                    }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                  >
                    {item.icon}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 2. How It Works */}
        <section className="about-section">
          <motion.div
            className="about-section-content reverse"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>answer once.<br />use everywhere.</motion.h2>
              <motion.p variants={fadeInUp}>
                Browse questions from the community or create your own. Your answers accumulate into a structured profile that represents who you are.
              </motion.p>
              <motion.p variants={fadeInUp}>
                Private answers are encrypted in your personal vault. Public and anonymous answers are shared on Farcaster and contribute to collective insights.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center', width: '100%', direction: 'ltr' }}>
                <motion.div
                  style={{ background: 'white', padding: '20px', borderRadius: '12px', width: '80%', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}
                  initial={{ y: 20, opacity: 0 }}
                  whileInView={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '8px' }}>Canonical Question</div>
                  <div style={{ fontSize: '18px', fontWeight: '600', color: '#334155' }}>What's your morning routine?</div>
                </motion.div>
                <ArrowRight className="text-slate-400" style={{ transform: 'rotate(90deg)' }} />
                <motion.div
                  style={{ background: '#f0f9ff', padding: '20px', borderRadius: '12px', width: '80%', border: '1px solid #bae6fd' }}
                  initial={{ y: 20, opacity: 0 }}
                  whileInView={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.4 }}
                >
                  <div style={{ fontSize: '14px', color: '#0284c7', fontWeight: '600' }}>Your Answer (Saved to Profile)</div>
                  <div style={{ fontSize: '16px', color: '#0c4a6e' }}>Coffee, meditation, then code review for 30 mins</div>
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 3. Privacy Control */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>privacy as<br />architecture.</motion.h2>
              <motion.p variants={fadeInUp}>
                Every answer has a visibility setting you choose. Your private data is end-to-end encrypted using Nillion SecretVault—neither qbase nor server owners can read what you don't want to share.
              </motion.p>
              <motion.p variants={fadeInUp}>
                Different answers can have different visibility. Your political views might be anonymous. Your expertise might be public. Your therapy insights might be private.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div className="privacy-dial-container">
                <div className="privacy-option active">
                  <div className="privacy-icon" style={{ background: '#10b981' }}><Globe size={20} /></div>
                  <div className="privacy-info">
                    <h4>Public</h4>
                    <span>Visible to everyone</span>
                  </div>
                </div>
                <div className="privacy-option">
                  <div className="privacy-icon" style={{ background: '#6366f1' }}><EyeOff size={20} /></div>
                  <div className="privacy-info">
                    <h4>Anonymous</h4>
                    <span>Public data, hidden identity</span>
                  </div>
                </div>
                <div className="privacy-option">
                  <div className="privacy-icon" style={{ background: '#ef4444' }}><Lock size={20} /></div>
                  <div className="privacy-info">
                    <h4>Private</h4>
                    <span>End-to-end encrypted</span>
                  </div>
                </div>
                <div className="privacy-option">
                  <div className="privacy-icon" style={{ background: '#f59e0b' }}><Users size={20} /></div>
                  <div className="privacy-info">
                    <h4>Allowlist</h4>
                    <span>Share with specific groups</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 4. Canonical Questions */}
        <section className="about-section">
          <motion.div
            className="about-section-content reverse"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>own your questions.<br />earn from engagement.</motion.h2>
              <motion.p variants={fadeInUp}>
                Instead of everyone asking variations of the same question, qbase uses semantic matching to guide users toward well-crafted, reusable questions.
              </motion.p>
              <motion.p variants={fadeInUp}>
                When you create a great question, you own it. As people save answers to your question, you earn <strong>Query Points (QP)</strong>. The more valuable your question, the more you earn.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div className="economy-visual-container">
                <div className="balance-scale">
                  <motion.div
                    className="scale-plate"
                    animate={{ y: [0, 10, 0] }}
                    transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <div className="coin-stack">
                      {[1, 2, 3].map(i => <div key={i} className="coin qp" />)}
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: '600' }}>COMMUNITY</span>
                  </motion.div>
                  <div style={{ width: '2px', height: '100%', background: '#cbd5e1' }} />
                  <motion.div
                    className="scale-plate"
                    animate={{ y: [0, -10, 0] }}
                    transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 2 }}
                  >
                    <div className="coin-stack">
                      <div className="coin qq" />
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: '600' }}>CREATOR</span>
                  </motion.div>
                </div>
                <div style={{ textAlign: 'center', fontSize: '14px', color: '#64748b' }}>
                  Value flows to question creators
                </div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 5. Query Points */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>daily allowance.<br />no hoarding.</motion.h2>
              <motion.p variants={fadeInUp}>
                Every verified user receives a daily allowance (~20 QP) to participate—asking questions, saving answers, taking quizzes, and engaging with the community.
              </motion.p>
              <motion.p variants={fadeInUp}>
                QP removes friction. You don't need to buy tokens to participate. You show up, you get points, you build your profile. Daily allowance resets at UTC 00:00. Use it or lose it.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div className="q-brain-container">
                <motion.div
                  className="brain-core"
                  animate={{ boxShadow: ['0 0 20px rgba(0,0,0,0.1)', '0 0 50px rgba(14, 165, 233, 0.4)', '0 0 20px rgba(0,0,0,0.1)'] }}
                  transition={{ duration: 3, repeat: Infinity }}
                >
                  QP
                </motion.div>
                {[1, 2, 3].map((i) => (
                  <motion.div
                    key={i}
                    className="brain-ring"
                    style={{ width: 80 + i * 40, height: 80 + i * 40 }}
                    animate={{
                      scale: [1, 1.1, 1],
                      opacity: [0.2, 0.1, 0.2],
                      rotate: [0, 360]
                    }}
                    transition={{
                      duration: 10 + i * 2,
                      repeat: Infinity,
                      ease: "linear"
                    }}
                  />
                ))}
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* Footer CTA */}
        <footer className="about-footer">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="footer-cta"
          >
            <h2 style={{ fontSize: '2rem', marginBottom: '24px', color: 'var(--qbase-text)' }}>ready to build your profile?</h2>
            <p style={{ marginBottom: '32px', color: 'var(--qbase-text-muted)' }}>qbase is currently in beta on Farcaster.</p>
            <button className="cta-primary" onClick={() => navigate('/questions')} style={{ margin: '0 auto' }}>
              start answering questions
              <ArrowRight size={18} />
            </button>
          </motion.div>
        </footer>

      </main>
    </div>
  );
};

export default AboutPage;
