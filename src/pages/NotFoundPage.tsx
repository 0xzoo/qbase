import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, ArrowLeft, Compass } from 'lucide-react';
import './NotFoundPage.css';

const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();

  const floatAnimation = {
    y: [0, -20, 0],
    transition: {
      duration: 3,
      repeat: Infinity as number,
      ease: [0.42, 0, 0.58, 1] as [number, number, number, number]
    }
  };

  const fadeInUp = {
    hidden: { opacity: 0, y: 30 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.8, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }
    }
  };

  return (
    <div className="not-found-container">
      <div className="not-found-background" />

      <motion.div
        className="not-found-content"
        initial="hidden"
        animate="visible"
        variants={{
          visible: {
            transition: {
              staggerChildren: 0.15
            }
          }
        }}
      >
        {/* Floating 404 Orb */}
        <motion.div
          className="error-orb-container"
          animate={floatAnimation}
        >
          <div className="error-orb">
            <span className="error-code">404</span>
          </div>
          <div className="orb-glow" />
        </motion.div>

        {/* Error Message */}
        <motion.h1
          variants={fadeInUp}
          className="error-title"
        >
          page not found
        </motion.h1>

        <motion.p
          variants={fadeInUp}
          className="error-subtitle"
        >
          looks like you've wandered off the map.<br />
          let's get you back on track.
        </motion.p>

        {/* Action Buttons */}
        <motion.div
          variants={fadeInUp}
          className="error-actions"
        >
          <button
            className="action-primary"
            onClick={() => navigate('/')}
          >
            <Home size={18} />
            go home
          </button>

          <button
            className="action-secondary"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft size={18} />
            go back
          </button>

          <button
            className="action-secondary"
            onClick={() => navigate('/questions')}
          >
            <Compass size={18} />
            explore
          </button>
        </motion.div>

        {/* Decorative Elements */}
        <div className="floating-shapes">
          <motion.div
            className="shape shape-1"
            animate={{
              y: [0, -30, 0],
              x: [0, 15, 0],
            }}
            transition={{
              duration: 5,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          <motion.div
            className="shape shape-2"
            animate={{
              y: [0, 25, 0],
              x: [0, -20, 0],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.5
            }}
          />
          <motion.div
            className="shape shape-3"
            animate={{
              y: [0, -20, 0],
              x: [0, 10, 0],
            }}
            transition={{
              duration: 4.5,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 1
            }}
          />
        </div>
      </motion.div>
    </div>
  );
};

export default NotFoundPage;
