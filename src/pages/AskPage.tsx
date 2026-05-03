import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Search, Sparkles, User, ArrowRight, Brain, Zap, Globe } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { Float, Stars } from '@react-three/drei';

// Interactive Components
const Logo = ({ className }: { className?: string }) => (
    <img src="/qbase.png" alt="Qbase Logo" className={className} />
);

const SearchBar = () => {
    const [query, setQuery] = useState("");
    const [isFocused, setIsFocused] = useState(false);

    const placeholders = [
        "Is AI conscious?",
        "Best React state manager?",
        "Future of crypto social?",
        "How to train for a marathon?",
    ];

    const [placeholderIndex, setPlaceholderIndex] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className={`relative max-w-2xl w-full mx-auto transition-all duration-300 ${isFocused ? 'scale-105' : 'scale-100'}`}>
            <div className="relative group">
                <div className={`absolute -inset-1 bg-gradient-to-r from-qbase-accent to-blue-600 rounded-full opacity-20 group-hover:opacity-40 blur transition duration-1000 group-hover:duration-200 ${isFocused ? 'opacity-60' : ''}`}></div>
                <div className="relative flex items-center bg-qbase-ivory dark:bg-slate-900 border border-qbase-slate/20 rounded-full shadow-2xl overflow-hidden p-2">
                    <div className="pl-4 text-qbase-text-dim">
                        <Search className="w-6 h-6" />
                    </div>
                    <input
                        type="text"
                        className="w-full bg-transparent border-none focus:ring-0 text-lg px-4 py-3 text-qbase-text placeholder-qbase-text-dim/50 outline-none"
                        placeholder={placeholders[placeholderIndex]}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                    />
                    <button className="px-6 py-3 bg-qbase-accent text-white rounded-full font-bold hover:bg-blue-400 transition-colors flex items-center gap-2">
                        <span>Ask</span>
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Search Suggestions / Data Sources */}
            <AnimatePresence>
                {isFocused && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute top-full left-0 right-0 mt-4 p-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-2xl border border-qbase-slate/20 shadow-xl z-20"
                    >
                        <div className="text-xs font-semibold text-qbase-text-dim uppercase tracking-wider mb-2 px-2">Searching across</div>
                        <div className="grid grid-cols-3 gap-2">
                            <div className="flex items-center gap-2 p-2 rounded-lg bg-blue-500/5 text-blue-500">
                                <Brain className="w-4 h-4" />
                                <span className="text-sm font-medium">AI Models</span>
                            </div>
                            <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/5 text-emerald-500">
                                <Globe className="w-4 h-4" />
                                <span className="text-sm font-medium">Social Graph</span>
                            </div>
                            <div className="flex items-center gap-2 p-2 rounded-lg bg-purple-500/5 text-purple-500">
                                <User className="w-4 h-4" />
                                <span className="text-sm font-medium">Your Context</span>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const FeatureCard = ({ icon: Icon, title, desc, delay, color }: any) => (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay, duration: 0.6 }}
        className="p-6 rounded-2xl bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm border border-qbase-slate/20 hover:border-qbase-accent/30 transition-all hover:shadow-lg group"
    >
        <div className={`w-12 h-12 rounded-xl ${color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
            <Icon className="w-6 h-6" />
        </div>
        <h3 className="text-xl font-bold text-qbase-text mb-2">{title}</h3>
        <p className="text-sm text-qbase-text-dim leading-relaxed">{desc}</p>
    </motion.div>
);

const StatPill = ({ label, value, color }: any) => (
    <div className="flex flex-col">
        <span className={`text-2xl font-bold ${color}`}>{value}</span>
        <span className="text-xs text-qbase-text-dim uppercase tracking-wide">{label}</span>
    </div>
);

const AnswerDemo = () => (
    <div className="w-full max-w-4xl mx-auto mt-20 p-6 bg-white dark:bg-slate-900 rounded-2xl border border-qbase-slate/20 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-emerald-500" />

        <div className="flex items-start gap-4 mb-6">
            <div className="w-10 h-10 rounded-full bg-qbase-accent/20 flex items-center justify-center text-qbase-accent shrink-0">
                <User className="w-5 h-5" />
            </div>
            <div>
                <h3 className="text-lg font-bold text-qbase-text">Is React Native still worth learning in 2026?</h3>
                <p className="text-qbase-text-dim text-sm">Asked by @zoon 2h ago</p>
            </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
            <div className="p-4 rounded-xl bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800/30">
                <div className="flex items-center gap-2 mb-3 text-blue-600 dark:text-blue-400">
                    <Zap className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase">AI Synthesis</span>
                </div>
                <p className="text-sm text-qbase-text/80 leading-relaxed">
                    Yes. While native Swift/Kotlin AI agents are growing, React Native remains the standard for cross-platform shipping. 78% of new YC apps use it.
                </p>
            </div>

            <div className="p-4 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800/30">
                <div className="flex items-center gap-2 mb-3 text-emerald-600 dark:text-emerald-400">
                    <Globe className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase">Human Consensus</span>
                </div>
                <div className="space-y-3">
                    <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-qbase-text">Worth it</span>
                        <span className="text-sm font-bold text-emerald-500">82%</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                        <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: '82%' }}></div>
                    </div>
                    <p className="text-xs text-qbase-text-dim">Based on 428 verified developer responses.</p>
                </div>
            </div>

            <div className="p-4 rounded-xl bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800/30 relative">
                <div className="absolute -top-2 -right-2 bg-purple-500 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm">YOU</div>
                <div className="flex items-center gap-2 mb-3 text-purple-600 dark:text-purple-400">
                    <Sparkles className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase">Your Context</span>
                </div>
                <p className="text-sm text-qbase-text/80 leading-relaxed">
                    Since you already know React and TypeScript from your last 3 projects, the learning curve is only ~2 weeks. It aligns with your goal to ship mobile apps Q1.
                </p>
            </div>
        </div>
    </div>
);

export default function AskPage() {
    return (
        <div className="min-h-screen bg-transparent relative overflow-x-hidden font-display selection:bg-qbase-accent/30 selection:text-qbase-text">
            {/* Background Elements */}
            <div className="fixed inset-0 z-[-1] pointer-events-none">
                <Canvas camera={{ position: [0, 0, 1] }}>
                    <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
                    <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
                        {/* Could add floating geometry here if needed */}
                    </Float>
                </Canvas>
            </div>

            {/* Header */}
            <header className="fixed top-0 w-full p-6 flex justify-between items-center z-50 bg-gradient-to-b from-qbase-bg via-qbase-bg/80 to-transparent backdrop-blur-[2px]">
                <div className="flex items-center gap-2">
                    <Logo className="w-8 h-8" />
                    <span className="font-bold text-xl text-qbase-text tracking-tight">Qbase</span>
                </div>
                <div className="flex gap-4">
                    <Link to="/about" className="text-sm font-medium text-qbase-text-dim hover:text-qbase-text transition-colors">Manifesto</Link>
                    <Link to="/questions" className="text-sm font-medium text-qbase-text hover:text-qbase-accent transition-colors">Launch App</Link>
                </div>
            </header>

            {/* Hero Section */}
            <section className="pt-48 pb-20 px-4 flex flex-col items-center justify-center min-h-[80vh]">
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.8, type: "spring" }}
                    className="mb-8"
                >
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 text-blue-500 text-xs font-bold uppercase tracking-wider mb-6 border border-blue-500/20">
                        <Sparkles className="w-3 h-3" />
                        The Universal Question Engine
                    </div>
                </motion.div>

                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.1 }}
                    className="text-5xl md:text-7xl font-bold text-center mb-6 bg-clip-text text-transparent bg-gradient-to-r from-qbase-text via-qbase-text to-qbase-text-dim max-w-4xl"
                >
                    Ask the Collective Mind.
                </motion.h1>

                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                    className="text-xl md:text-2xl text-qbase-text-dim text-center mb-12 max-w-2xl font-light"
                >
                    Tap into a global knowledge graph of humans and AI. <br className="hidden md:block" /> No SEO spam. No links. Just truth.
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.3 }}
                    className="w-full px-4 z-10"
                >
                    <SearchBar />
                </motion.div>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 1, delay: 1 }}
                    className="mt-16 flex gap-12 text-center"
                >
                    <StatPill label="Verified Humans" value="8,420" color="text-emerald-500" />
                    <StatPill label="Questions Answered" value="142k" color="text-blue-500" />
                    <StatPill label="AI Syntheses" value="1.2M" color="text-purple-500" />
                </motion.div>
            </section>

            {/* Demo Section */}
            <section className="py-20 px-4 bg-qbase-slate/5 border-y border-qbase-slate/10 overflow-hidden">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl font-bold text-qbase-text mb-4">The Trinity of Answers</h2>
                        <p className="text-qbase-text-dim">Why rely on one source when you can have three?</p>
                    </div>

                    <AnswerDemo />
                </div>
            </section>

            {/* Features Grid */}
            <section className="py-32 px-4">
                <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
                    <FeatureCard
                        icon={Brain}
                        title="AI Synthesis"
                        desc="Instant answers synthesized from top models (Claude, GPT-4). No digging through links."
                        color="bg-blue-500/10 text-blue-500"
                        delay={0}
                    />
                    <FeatureCard
                        icon={Globe}
                        title="Human Consensus"
                        desc="Real data from verified humans. Statistical truth, not just probabilistic text generation."
                        color="bg-emerald-500/10 text-emerald-500"
                        delay={0.2}
                    />
                    <FeatureCard
                        icon={Zap}
                        title="Canonical Nodes"
                        desc="We structure the internet's chaos. One question, one node, zero duplicates."
                        color="bg-yellow-500/10 text-yellow-500"
                        delay={0.4}
                    />
                </div>
            </section>

            {/* Footer CTA */}
            <footer className="py-20 px-4 text-center border-t border-qbase-slate/20">
                <h2 className="text-4xl font-bold mb-8 text-qbase-text">Stop Searching. Start Asking.</h2>
                <Link
                    to="/questions"
                    className="inline-flex items-center gap-2 px-8 py-4 bg-qbase-text text-qbase-bg rounded-full font-bold text-lg hover:bg-qbase-accent hover:text-white transition-all transform hover:scale-105"
                >
                    Launch Qbase
                    <ArrowRight className="w-5 h-5" />
                </Link>
                <div className="mt-12 text-sm text-qbase-text-dim">
                    © 2026 Qbase.
                </div>
            </footer>
        </div>
    );
}
