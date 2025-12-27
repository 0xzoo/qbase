import { motion, type Variants } from 'framer-motion';

const PyramidNetwork = () => {
  const draw: Variants = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: (i: number) => ({
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { delay: i * 0.5, type: "spring", duration: 1.5, bounce: 0 },
        opacity: { delay: i * 0.5, duration: 0.01 }
      }
    })
  };

  const pulse: Variants = {
    initial: { scale: 1, opacity: 0.5 },
    animate: {
      scale: [1, 1.2, 1],
      opacity: [0.5, 1, 0.5],
      transition: { duration: 2, repeat: Infinity }
    }
  };

  return (
    <div className="pyramid-network-container">
      <motion.svg
        width="600"
        height="400"
        viewBox="0 0 600 400"
        initial="hidden"
        animate="visible"
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
      >
        {/* Central Pyramid */}
        <motion.path
          d="M300 50 L150 300 L450 300 Z"
          fill="none"
          stroke="rgba(44, 62, 80, 0.8)"
          strokeWidth="2"
          custom={0}
          variants={draw}
        />
        <motion.path
          d="M300 50 L300 300"
          fill="none"
          stroke="rgba(44, 62, 80, 0.4)"
          strokeWidth="1"
          custom={0.5}
          variants={draw}
        />

        {/* Left Pyramid (Smaller) */}
        <motion.path
          d="M100 150 L20 280 L180 280 Z"
          fill="none"
          stroke="rgba(44, 62, 80, 0.6)"
          strokeWidth="1.5"
          custom={1}
          variants={draw}
        />

        {/* Right Pyramid (Smaller) */}
        <motion.path
          d="M500 150 L420 280 L580 280 Z"
          fill="none"
          stroke="rgba(44, 62, 80, 0.6)"
          strokeWidth="1.5"
          custom={1.5}
          variants={draw}
        />

        {/* Connecting Lines (Network) */}
        <motion.line
          x1="180" y1="200" x2="250" y2="200"
          stroke="rgba(52, 152, 219, 0.4)"
          strokeWidth="1"
          custom={2}
          variants={draw}
        />
        <motion.line
          x1="420" y1="200" x2="350" y2="200"
          stroke="rgba(52, 152, 219, 0.4)"
          strokeWidth="1"
          custom={2.5}
          variants={draw}
        />

        {/* Data Packets (Circles moving along paths) */}
        {/* Note: offset-path is not fully supported in all browsers for SVG elements in the same way as CSS motion path, 
            so we'll use simple circle translations for now or framer motion's layout animations if needed. 
            Actually, let's use simple circles moving between points for robustness. */}

        <motion.circle
          cx="0" cy="0" r="4"
          fill="#3498db"
          initial={{ x: 180, y: 200, opacity: 0 }}
          animate={{
            x: [180, 250],
            opacity: [0, 1, 0],
          }}
          transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 0.5 }}
        />

        <motion.circle
          cx="0" cy="0" r="4"
          fill="#3498db"
          initial={{ x: 420, y: 200, opacity: 0 }}
          animate={{
            x: [420, 350],
            opacity: [0, 1, 0],
          }}
          transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 0.2 }}
        />

        {/* Emission from top */}
        <motion.circle
          cx="300" cy="50" r="6"
          fill="#f1c40f"
          variants={pulse}
          initial="initial"
          animate="animate"
        />

        <motion.circle
          cx="300" cy="50" r="30"
          fill="none"
          stroke="#f1c40f"
          strokeWidth="1"
          initial={{ scale: 0.5, opacity: 1 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 2, repeat: Infinity }}
        />

      </motion.svg>
    </div>
  );
};

export default PyramidNetwork;
