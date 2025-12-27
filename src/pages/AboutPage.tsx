
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import {
  ArrowRight,
  Lock,
  EyeOff,
  Network,
  Globe
} from 'lucide-react';
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

      {/* Header */}
      <header className="about-header">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="about-logo"
          onClick={() => navigate('/')}
        >
          <img src="/qbase.svg" alt="Qbase" className="logo-icon" />
          <span>qbase</span>
        </motion.div>
        <nav>
          <button className="enter-button" onClick={() => navigate('/questions')}>
            enter app
          </button>
        </nav>
      </header>

      <main>
        {/* Hero Section */}
        <section className="about-hero">
          <motion.div
            className="about-hero-content"
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
          >
            <motion.h1 variants={fadeInUp} className="about-title">
              the api for you
            </motion.h1>
            <motion.p variants={fadeInUp} className="about-subtitle">
              stop re-typing your life. qbase is a sovereign digital mind that learns you once and serves you everywhere.
            </motion.p>
          </motion.div>
        </section>

        {/* 1. Mission: Digital Sovereignty */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>digital sovereignty,<br />not digital slavery.</motion.h2>
              <motion.p variants={fadeInUp}>
                Every app asks the same questions. Facebook, Netflix, and Amazon all build fragmented profiles of you that <em>they</em> own.
              </motion.p>
              <motion.p variants={fadeInUp}>
                Qbase flips the model. You build one profile. You own it. You grant access to apps and AI agents on your terms.
              </motion.p>
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
                {[0, 72, 144, 216, 288].map((deg, i) => (
                  <motion.div
                    key={i}
                    className="node-satellite"
                    style={{
                      top: '50%',
                      left: '50%',
                    }}
                    animate={{
                      x: [Math.cos(deg * Math.PI / 180) * 100, Math.cos((deg + 360) * Math.PI / 180) * 100],
                      y: [Math.sin(deg * Math.PI / 180) * 100, Math.sin((deg + 360) * Math.PI / 180) * 100],
                    }}
                    transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                  >
                    <Network size={20} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 2. How It Works: Canonical Questions */}
        <section className="about-section">
          <motion.div
            className="about-section-content reverse"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>one question,<br />one answer.</motion.h2>
              <motion.p variants={fadeInUp}>
                We use "Canonical Questions" — a universal registry of questions like "What is your favorite movie?"
              </motion.p>
              <motion.p variants={fadeInUp}>
                Answer it once on Qbase. That answer becomes a permanent part of your digital DNA, accessible by any authorized service via our API.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', alignItems: 'center', width: '100%' }}>
                <motion.div
                  style={{ background: 'white', padding: '20px', borderRadius: '12px', width: '80%', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}
                  initial={{ y: 20, opacity: 0 }}
                  whileInView={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  <div style={{ fontSize: '14px', color: '#64748b', marginBottom: '8px' }}>Canonical ID: #8492</div>
                  <div style={{ fontSize: '18px', fontWeight: '600', color: '#334155' }}>What is your dietary preference?</div>
                </motion.div>
                <ArrowRight className="text-slate-400" style={{ transform: 'rotate(90deg)' }} />
                <motion.div
                  style={{ background: '#f0f9ff', padding: '20px', borderRadius: '12px', width: '80%', border: '1px solid #bae6fd' }}
                  initial={{ y: 20, opacity: 0 }}
                  whileInView={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.4 }}
                >
                  <div style={{ fontSize: '14px', color: '#0284c7', fontWeight: '600' }}>Your Answer</div>
                  <div style={{ fontSize: '18px', color: '#0c4a6e' }}>Vegetarian</div>
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 3. Privacy: The Dial */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>privacy is a dial,<br />not a switch.</motion.h2>
              <motion.p variants={fadeInUp}>
                Not everything belongs on the public web. You choose the privacy level for every single answer.
              </motion.p>
              <motion.p variants={fadeInUp}>
                <strong>Public:</strong> Open for the world (Cloudflare D1).<br />
                <strong>Private:</strong> Encrypted just for you (Nillion SecretVault).<br />
                <strong>Anonymous:</strong> Public data, hidden identity.
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
                    <span>Data public, you hidden</span>
                  </div>
                </div>
                <div className="privacy-option">
                  <div className="privacy-icon" style={{ background: '#ef4444' }}><Lock size={20} /></div>
                  <div className="privacy-info">
                    <h4>Private</h4>
                    <span>Encrypted vault (Nillion)</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 4. Economy: Creator Pays */}
        <section className="about-section">
          <motion.div
            className="about-section-content reverse"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>answering is free.<br />asking costs.</motion.h2>
              <motion.p variants={fadeInUp}>
                We believe your data is labor. In Qbase, the "Creator Pays" model ensures that answering questions is always free.
              </motion.p>
              <motion.p variants={fadeInUp}>
                Askers pay in <strong>QP</strong> (Query Points) to access your insights. You earn rewards for high-quality contributions.
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
                    <span style={{ fontSize: '12px', fontWeight: '600' }}>ASKER</span>
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
                    <span style={{ fontSize: '12px', fontWeight: '600' }}>ANSWERER</span>
                  </motion.div>
                </div>
                <div style={{ textAlign: 'center', fontSize: '14px', color: '#64748b' }}>
                  Value flows to data providers
                </div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* 5. Q: The AI Director */}
        <section className="about-section">
          <motion.div
            className="about-section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="about-text">
              <motion.h2 variants={fadeInUp}>meet Q.<br />your digital director.</motion.h2>
              <motion.p variants={fadeInUp}>
                Q is the AI director of the protocol. Q interviews you to help build your profile, analyzes aggregate data for humanity, and even holds a seat in governance.
              </motion.p>
              <motion.p variants={fadeInUp}>
                Q ensures the system serves long-term human interests, not just short-term profit.
              </motion.p>
            </div>
            <motion.div variants={fadeInUp} className="about-visual">
              <div className="q-brain-container">
                <motion.div
                  className="brain-core"
                  animate={{ boxShadow: ['0 0 20px rgba(0,0,0,0.1)', '0 0 50px rgba(14, 165, 233, 0.4)', '0 0 20px rgba(0,0,0,0.1)'] }}
                  transition={{ duration: 3, repeat: Infinity }}
                >
                  Q
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
            <h2 style={{ fontSize: '2rem', marginBottom: '24px', color: 'var(--qbase-text)' }}>ready to claim your sovereignty?</h2>
            <button className="cta-primary" onClick={() => navigate('/questions')} style={{ margin: '0 auto' }}>
              start building your profile
              <ArrowRight size={18} />
            </button>
          </motion.div>
        </footer>

      </main>
    </div>
  );
};

export default AboutPage;
