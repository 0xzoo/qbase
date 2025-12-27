import React from 'react';
import { motion } from 'framer-motion';

const ScientificVisuals: React.FC = () => {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      {/* Subtle Grid Background */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(var(--qbase-text) 1px, transparent 1px), linear-gradient(90deg, var(--qbase-text) 1px, transparent 1px)`,
          backgroundSize: '40px 40px'
        }}
      />

      {/* Floating Geometric Elements */}
      <motion.div
        className="absolute top-1/4 right-1/4 w-96 h-96 border border-[var(--qbase-accent)] rounded-full opacity-10"
        animate={{
          rotate: 360,
          scale: [1, 1.1, 1],
        }}
        transition={{
          duration: 60,
          repeat: Infinity,
          ease: "linear"
        }}
      />

      <motion.div
        className="absolute bottom-1/3 left-1/3 w-64 h-64 border border-[var(--qbase-gold)] rounded-full opacity-5"
        animate={{
          rotate: -360,
          scale: [1, 0.9, 1],
        }}
        transition={{
          duration: 45,
          repeat: Infinity,
          ease: "linear"
        }}
      />

      {/* Particle Field Effect (Simplified with CSS/Divs for performance) */}
      <div className="absolute top-0 left-0 w-full h-full">
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute bg-[var(--qbase-text)] rounded-full opacity-10"
            style={{
              width: Math.random() * 4 + 1 + 'px',
              height: Math.random() * 4 + 1 + 'px',
              top: Math.random() * 100 + '%',
              left: Math.random() * 100 + '%',
            }}
            animate={{
              y: [0, -100],
              opacity: [0, 0.2, 0]
            }}
            transition={{
              duration: Math.random() * 10 + 10,
              repeat: Infinity,
              ease: "linear",
              delay: Math.random() * 10
            }}
          />
        ))}
      </div>

      {/* Gradient Overlay for Depth */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--qbase-bg)] to-[var(--qbase-bg)] opacity-80" />
    </div>
  );
};

export default ScientificVisuals;
