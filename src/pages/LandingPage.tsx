import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Zap, Bot, Shield, Share2, Heart, Fingerprint } from 'lucide-react';
import './LandingPage.css';

const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const fadeInUp = {
    hidden: { opacity: 0, y: 30 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: [0.43, 0.13, 0.23, 0.96] } }
  } as const;

  const staggerContainer = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15
      }
    }
  } as const;

  return (
    <div className="landing-page-container" style={{
      '--scroll-progress': Math.min(scrollY / 1000, 1)
    } as React.CSSProperties}>
      {/* Dynamic Background */}
      <div className="landing-background" />

      <header className="landing-header">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="landing-logo"
        >
          <img src="/qbase.svg" alt="Qbase" className="logo-icon" />
          <span>qbase</span>
        </motion.div>
        <nav className="landing-nav">
          <motion.button
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            onClick={() => navigate('/questions')}
            className="enter-button"
          >
            enter app
          </motion.button>
        </nav>
      </header>

      <main>
        {/* Hero Section */}
        <section className="landing-hero">
          <motion.div
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="hero-content"
          >

            <motion.h1 variants={fadeInUp} className="hero-title">
              the api for you
            </motion.h1>

            <motion.p variants={fadeInUp} className="hero-subtitle">
              stop re-typing your life. create a portable, structured, and sovereign digital mind that serves you in a world of ai.
            </motion.p>

            <motion.div variants={fadeInUp} className="hero-actions">
              <button className="cta-primary" onClick={() => navigate('/questions')}>
                start building
                <ArrowRight size={18} />
              </button>
              <button className="cta-secondary" onClick={() => navigate('/about')}>
                read manifesto
              </button>
            </motion.div>
          </motion.div>
        </section>

        {/* The Wedge: Social Coordination */}
        <section className="landing-section wedge-section">
          <motion.div
            className="section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="section-text">
              <motion.h2 variants={fadeInUp}>social coordination,<br />solved.</motion.h2>
              <motion.p variants={fadeInUp}>
                "fill out this form for my dinner party" is friction.<br />
                sending a qbase link is magic.
              </motion.p>
              <motion.ul variants={fadeInUp} className="feature-list">
                <li><Share2 size={16} /> host sends link</li>
                <li><Fingerprint size={16} /> friends answer for free</li>
                <li><Zap size={16} /> instant structured data</li>
              </motion.ul>
            </div>
            <motion.div variants={fadeInUp} className="visual-card wedge-visual">
              <div className="mock-chat">
                <div className="chat-bubble host">hey, coming to dinner friday? any allergies?</div>
                <div className="chat-bubble guest">
                  <div className="qbase-link-preview">
                    <div className="preview-icon"></div>
                    <div className="preview-text">
                      <strong>Dinner Party RSVP</strong>
                      <span>tap to answer instantly</span>
                    </div>
                  </div>
                </div>
                <div className="chat-status">✓ answered by 5 friends</div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* The Economy: Q Points (QP) */}
        <section className="landing-section economy-section">
          <motion.div
            className="section-content reverse"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="section-text">
              <motion.div variants={fadeInUp} className="section-badge">
                <Zap size={14} />
                <span>new economy</span>
              </motion.div>
              <motion.h2 variants={fadeInUp}>daily fuel<br />for your digital self.</motion.h2>
              <motion.p variants={fadeInUp}>
                a "use it or lose it" energy system. every user gets <strong>100 QP</strong> daily.
              </motion.p>
              <motion.div variants={fadeInUp} className="economy-grid">
                <div className="economy-item">
                  <span className="cost">0 QP</span>
                  <span className="action">answer</span>
                </div>
                <div className="economy-item">
                  <span className="cost">0 QP</span>
                  <span className="action">take quiz</span>
                </div>
                <div className="economy-item highlight">
                  <span className="cost">10 QP</span>
                  <span className="action">ask</span>
                </div>
                <div className="economy-item highlight">
                  <span className="cost">20 QP</span>
                  <span className="action">unlock insights</span>
                </div>
              </motion.div>
            </div>
            <motion.div variants={fadeInUp} className="visual-card economy-visual">
              <div className="fuel-orb-container">
                <div className="fuel-orb"></div>
                <div className="fuel-label">100 QP</div>
                <div className="fuel-sub">daily allowance</div>
              </div>
            </motion.div>
          </motion.div>
        </section>

        {/* The Future: Agent Ready */}
        <section className="landing-section ai-section">
          <motion.div
            className="section-content"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={staggerContainer}
          >
            <div className="section-text">
              <motion.h2 variants={fadeInUp}>don't train their model.<br />train yours.</motion.h2>
              <motion.p variants={fadeInUp}>
                your ai should know you. point your agents to your qbase to give them your tone, ethics, and decision-making heuristics.
              </motion.p>
              <motion.div variants={fadeInUp} className="ai-features">
                <div className="ai-feature">
                  <Bot size={20} />
                  <span>portable context</span>
                </div>
                <div className="ai-feature">
                  <Shield size={20} />
                  <span>sovereign weights</span>
                </div>
                <div className="ai-feature">
                  <Heart size={20} />
                  <span>human alignment</span>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </section>

        {/* Footer / Protocol */}
        <footer className="landing-footer-section">
          <div className="footer-content">
            <div className="footer-brand">
              <div className="logo-icon small"></div>
              <span>qbase protocol</span>
            </div>
            <div className="footer-links">
              <a href="#">manifesto</a>
              <a href="#">tokenomics</a>
              <a href="#">farcaster</a>
            </div>
            <div className="footer-copy">
              built on Farcaster. privacy by default.
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
};

export default LandingPage;
