import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#@%&*';

const DataStream: React.FC = () => {
  const [streams, setStreams] = useState<number[]>([]);

  useEffect(() => {
    // Create random streams
    const count = Math.floor(window.innerWidth / 30);
    setStreams(Array.from({ length: count }).map((_, i) => i));
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none z-0 opacity-10 overflow-hidden">
      {streams.map((i) => (
        <StreamColumn key={i} index={i} />
      ))}
    </div>
  );
};

const StreamColumn = ({ index }: { index: number }) => {
  const [text, setText] = useState('');
  const duration = 2 + Math.random() * 5;
  const delay = Math.random() * 5;

  useEffect(() => {
    const length = 10 + Math.floor(Math.random() * 20);
    let str = '';
    for (let i = 0; i < length; i++) {
      str += characters.charAt(Math.floor(Math.random() * characters.length)) + '\n';
    }
    setText(str);
  }, []);

  return (
    <motion.div
      className="absolute top-0 text-xs font-mono text-cyan-500 whitespace-pre leading-none"
      style={{
        left: `${index * 30}px`,
        fontSize: '10px',
      }}
      initial={{ y: -500 }}
      animate={{ y: window.innerHeight + 500 }}
      transition={{
        duration: duration,
        repeat: Infinity,
        ease: "linear",
        delay: delay,
      }}
    >
      {text}
    </motion.div>
  );
};

export default DataStream;
