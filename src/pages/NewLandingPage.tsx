import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Infinity as InfinityIcon,
  SlidersHorizontal,
  Plug,
  Lock,
  Shield,
  Eye,
  EyeOff,
  Users,
  ChevronDown
} from 'lucide-react';
import './NewLandingPage.css';

// Constellation Node Component
const ConstellationNode: React.FC<{ 
  x: number; 
  y: number; 
  size: number; 
  delay: number;
  type: 'public' | 'private' | 'anonymous' | 'allowlist';
}> = ({ x, y, size, delay, type }) => {
  const colorMap = {
    public: 'var(--node-public)',
    private: 'var(--node-private)',
    anonymous: 'var(--node-anonymous)',
    allowlist: 'var(--node-allowlist)',
  };
  
  return (
    <motion.div
      className="constellation-node"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        backgroundColor: colorMap[type],
      }}
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ 
        duration: 0.8, 
        delay,
        ease: [0.34, 1.56, 0.64, 1]
      }}
    />
  );
};

// Animated constellation background
const ConstellationBackground: React.FC = () => {
  const nodes = [
    { x: 15, y: 20, size: 8, delay: 0.2, type: 'public' as const },
    { x: 25, y: 35, size: 6, delay: 0.4, type: 'private' as const },
    { x: 40, y: 15, size: 10, delay: 0.3, type: 'public' as const },
    { x: 55, y: 40, size: 7, delay: 0.5, type: 'anonymous' as const },
    { x: 70, y: 25, size: 9, delay: 0.6, type: 'allowlist' as const },
    { x: 80, y: 45, size: 6, delay: 0.7, type: 'public' as const },
    { x: 30, y: 60, size: 8, delay: 0.8, type: 'private' as const },
    { x: 60, y: 70, size: 7, delay: 0.9, type: 'anonymous' as const },
    { x: 85, y: 65, size: 5, delay: 1.0, type: 'public' as const },
    { x: 20, y: 75, size: 6, delay: 1.1, type: 'allowlist' as const },
    { x: 45, y: 55, size: 12, delay: 0.1, type: 'public' as const },
    { x: 75, y: 80, size: 8, delay: 1.2, type: 'private' as const },
  ];
  
  return (
    <div className="constellation-container">
      {nodes.map((node, i) => (
        <ConstellationNode key={i} {...node} />
      ))}
      <svg className="constellation-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        <motion.path
          d="M15,20 Q30,30 40,15 T70,25 M25,35 Q40,45 55,40 M45,55 L60,70 M30,60 Q50,65 75,80"
          fill="none"
          stroke="var(--constellation-line)"
          strokeWidth="0.15"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 2, delay: 0.5, ease: "easeOut" }}
        />
      </svg>
    </div>
  );
};

const NewLandingPage: React.FC = () => {
  const navigate = useNavigate();
  
  const fadeInUp = {
    hidden: { opacity: 0, y: 40 },
    visible: { 
      opacity: 1, 
      y: 0, 
      transition: { duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] } 
    }
  };

  const staggerContainer = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.1
      }
    }
  };

  const pillars = [
    {
      icon: <InfinityIcon size={28} strokeWidth={1.5} />,
      title: "Write Once, Answer Forever",
      description: "Answer 'What motivates you?' today. Use it in job applications, AI chats, social profiles—forever. Never repeat yourself again."
    },
    {
      icon: <SlidersHorizontal size={28} strokeWidth={1.5} />,
      title: "Granular Control",
      description: "Public for reputation. Anonymous for truth. Private for utility. Allowlist for collaboration. Every answer, your rules."
    },
    {
      icon: <Plug size={28} strokeWidth={1.5} />,
      title: "Cross-Platform Power",
      description: "Unlike Apple Intelligence or ChatGPT memory, Qbase works everywhere. Your context, portable."
    }
  ];

  const comparisonRows = [
    { them: '"Trust us with your data"', us: 'Cryptographically encrypted' },
    { them: 'Policy promises can change', us: 'Math doesn\'t change' },
    { them: 'All-or-nothing access', us: 'Granular control per answer' },
    { them: 'Corporate ownership', us: 'You own the keys' },
  ];

  return (
    <div className="new-landing">
      {/* Header */}
      <header className="landing-header-new">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="landing-logo-new"
        >
          <img src="/qbase.svg" alt="Qbase" className="logo-icon-new" />
          <span>qbase</span>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
        >
          <nav className="landing-nav-new">
            <button className="nav-link" onClick={() => navigate('/about')}>
              About
            </button>
            <button className="nav-cta" onClick={() => navigate('/questions')}>
              Launch App
              <ArrowRight size={16} />
            </button>
          </nav>
        </motion.div>
      </header>

      {/* Hero Section */}
      <section className="hero-section">
        <ConstellationBackground />
        <motion.div 
          className="hero-content-new"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
        >
          <motion.div
            initial="hidden"
            animate="visible"
            variants={staggerContainer}
            className="hero-text"
          >
            <motion.h1 variants={fadeInUp} className="hero-headline">
              Your Context.<br />
              Your Control.<br />
              <span className="accent">Forever Useful.</span>
            </motion.h1>
            
            <motion.p variants={fadeInUp} className="hero-subheadline">
              Answer once. Use everywhere.<br />
              The personal context layer for the age of AI.
            </motion.p>

            <motion.div variants={fadeInUp} className="hero-ctas">
              <button className="btn-primary" onClick={() => navigate('/questions')}>
                Launch Qbase
                <ArrowRight size={18} />
              </button>
              <button className="btn-secondary" onClick={() => {
                document.getElementById('problem-section')?.scrollIntoView({ behavior: 'smooth' });
              }}>
                See How It Works
                <ChevronDown size={18} />
              </button>
            </motion.div>
          </motion.div>
        </motion.div>
        
        <motion.div 
          className="scroll-indicator"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2, duration: 1 }}
        >
          <ChevronDown size={24} />
        </motion.div>
      </section>

      {/* Problem Section */}
      <section id="problem-section" className="problem-section">
        <motion.div
          className="section-container"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={staggerContainer}
        >
          <motion.h2 variants={fadeInUp} className="section-headline">
            D-R-Y: Don't Repeat Yourself
          </motion.h2>

          <div className="problem-grid">
            <motion.div variants={fadeInUp} className="problem-card">
              <div className="problem-icon scattered">
                <div className="fragment"></div>
                <div className="fragment"></div>
                <div className="fragment"></div>
              </div>
              <h3>Scattered</h3>
              <p>Your preferences scattered across dozens of platforms</p>
              <span className="problem-quote">"What's your favorite book?" asked 47 times</span>
            </motion.div>

            <motion.div variants={fadeInUp} className="problem-card">
              <div className="problem-icon trapped">
                <Lock size={32} />
              </div>
              <h3>Trapped</h3>
              <p>Each platform locks your data in their silo</p>
              <span className="problem-quote">Facebook knows you better than your friends do</span>
            </motion.div>

            <motion.div variants={fadeInUp} className="problem-card">
              <div className="problem-icon starting-over">
                <div className="refresh-circle"></div>
              </div>
              <h3>Starting Over</h3>
              <p>Every new AI starts from zero</p>
              <span className="problem-quote">"Tell me about yourself" ∞</span>
            </motion.div>
          </div>

          <motion.p variants={fadeInUp} className="problem-summary">
            Your digital identity is fragmented. Your most valuable data—your opinions, 
            preferences, values—exists only in corporate databases, reformatted for ad targeting, 
            inaccessible to you.
            <br /><br />
            <strong>There's no API for identity. No "write once, answer forever." Until now.</strong>
          </motion.p>
        </motion.div>
      </section>

      {/* Solution Section */}
      <section className="solution-section">
        <motion.div
          className="section-container"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={staggerContainer}
        >
          <motion.h2 variants={fadeInUp} className="section-headline">
            One Answer. Infinite Use.
          </motion.h2>
          <motion.p variants={fadeInUp} className="section-subheadline">
            Qbase is your personal knowledge base. Answer questions once, control who sees what, 
            and make your context portable across every platform and AI.
          </motion.p>

          <div className="pillars-grid">
            {pillars.map((pillar, index) => (
              <motion.div
                key={index}
                variants={fadeInUp}
                className="pillar-card"
              >
                <div className="pillar-icon">{pillar.icon}</div>
                <h3>{pillar.title}</h3>
                <p>{pillar.description}</p>
              </motion.div>
            ))}
          </div>

          {/* Interactive visibility demo */}
          <motion.div variants={fadeInUp} className="visibility-demo">
            <div className="demo-question">
              <span className="demo-label">Your answer to:</span>
              <span className="demo-q">"What's your dream project?"</span>
            </div>
            <VisibilityToggle />
          </motion.div>
        </motion.div>
      </section>

      {/* Privacy Section */}
      <section className="privacy-section">
        <motion.div
          className="section-container"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={staggerContainer}
        >
          <motion.div variants={fadeInUp} className="privacy-header">
            <Shield size={48} strokeWidth={1} className="privacy-shield" />
            <h2 className="section-headline">
              Privacy You Can Prove,<br />
              <span className="accent">Not Just Promise</span>
            </h2>
          </motion.div>

          <motion.p variants={fadeInUp} className="privacy-body">
            Most platforms say "we value your privacy." Qbase proves it with cryptography.
            <br /><br />
            Your sensitive data is end-to-end encrypted 
            at the field level. We can't see it. Hackers can't breach it. 
            Privacy isn't a policy—it's mathematics.
          </motion.p>

          <motion.div variants={fadeInUp} className="comparison-table">
            <div className="comparison-header">
              <span>Traditional Platforms</span>
              <span>Qbase</span>
            </div>
            {comparisonRows.map((row, i) => (
              <div key={i} className="comparison-row">
                <span className="them">{row.them}</span>
                <span className="us">{row.us}</span>
              </div>
            ))}
          </motion.div>

          <motion.div variants={fadeInUp} className="trust-badges">
            <div className="badge">
              <Lock size={16} />
              <span>End-to-End Encryption</span>
            </div>
            <div className="badge">
              <Shield size={16} />
              <span>End-to-End Encrypted</span>
            </div>
            <div className="badge">
              <Eye size={16} />
              <span>Open Source</span>
            </div>
          </motion.div>
        </motion.div>
      </section>

      {/* Final CTA Section */}
      <section className="cta-section">
        <motion.div
          className="section-container"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={staggerContainer}
        >
          <motion.h2 variants={fadeInUp} className="cta-headline">
            Start Building Your Context Today
          </motion.h2>
          <motion.p variants={fadeInUp} className="cta-subheadline">
            Answer your first question. It's free, it's yours, and it's useful forever.
          </motion.p>
          <motion.div variants={fadeInUp} className="cta-buttons">
            <button className="btn-primary large" onClick={() => navigate('/questions')}>
              Launch Qbase
              <ArrowRight size={20} />
            </button>
          </motion.div>
          <motion.p variants={fadeInUp} className="cta-trust">
            Open source. Encrypted. Owned by you.
          </motion.p>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="landing-footer-new">
        <div className="footer-container">
          <div className="footer-brand">
            <img src="/qbase.svg" alt="Qbase" className="footer-logo" />
            <span>qbase</span>
          </div>
          <div className="footer-links">
            <a href="/about">About</a>
            <a href="https://farcaster.xyz/~/channel/qbase" target="_blank" rel="noopener noreferrer">Farcaster</a>
            <a href="https://github.com/qbase-tech" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
          <div className="footer-copy">
            Built on Farcaster. Privacy by default.
          </div>
        </div>
      </footer>
    </div>
  );
};

// Visibility toggle component
const VisibilityToggle: React.FC = () => {
  const [visibility, setVisibility] = useState<'public' | 'private' | 'anonymous' | 'allowlist'>('public');
  
  const options = [
    { key: 'public' as const, label: 'Public', icon: <Eye size={16} />, desc: 'Everyone can see' },
    { key: 'private' as const, label: 'Private', icon: <EyeOff size={16} />, desc: 'Only you' },
    { key: 'anonymous' as const, label: 'Anonymous', icon: <Users size={16} />, desc: 'Public, but hidden author' },
    { key: 'allowlist' as const, label: 'Allowlist', icon: <Users size={16} />, desc: 'Specific groups only' },
  ];

  return (
    <div className="visibility-toggle">
      <div className="toggle-options">
        {options.map(opt => (
          <button
            key={opt.key}
            className={`toggle-option ${visibility === opt.key ? 'active' : ''}`}
            onClick={() => setVisibility(opt.key)}
          >
            {opt.icon}
            <span className="opt-label">{opt.label}</span>
          </button>
        ))}
      </div>
      <div className="toggle-description">
        <span className={`visibility-indicator ${visibility}`}></span>
        {options.find(o => o.key === visibility)?.desc}
      </div>
    </div>
  );
};

export default NewLandingPage;

