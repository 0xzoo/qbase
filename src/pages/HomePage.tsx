import React, { useRef } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Eye, Shield, Ghost, Brain, Globe } from 'lucide-react';
import LoadingAnimation from '../components/LoadingAnimation';

const Logo = ({ className }: { className?: string }) => (
    <img src="/qbase.png" alt="Qbase Logo" className={className} />
);

function Header() {
    return (
        <motion.div
            className="fixed top-0 left-0 right-0 z-50 px-6 py-4 flex justify-between items-center"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
        >
            <div className="flex items-center gap-2">
                <Logo className="w-8 h-8" />
                <span className="font-display font-bold text-xl text-qbase-text">Qbase</span>
            </div>
            <Link
                to="/questions"
                className="px-4 py-2 rounded-full border border-qbase-slate/20 bg-qbase-ivory/50 backdrop-blur-md text-sm font-medium hover:bg-qbase-ivory/80 transition-colors"
            >
                Launch App
            </Link>
        </motion.div>
    );
}

function HeroSection() {
    return (
        <section className="relative h-screen w-full flex items-center justify-center overflow-hidden">
            <div className="absolute inset-0 z-0 opacity-40">
                <LoadingAnimation variant="hero" className="w-full h-full scale-150" />
            </div>

            <div className="relative z-10 text-center px-4 max-w-4xl mx-auto">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8 }}
                    className="flex flex-col items-center"
                >
                    <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.2, duration: 0.8 }}
                        className="mb-8"
                    >
                        <Logo className="w-24 h-24 md:w-32 md:h-32 drop-shadow-[0_0_15px_rgba(125,211,252,0.3)]" />
                    </motion.div>
                    <h1 className="text-6xl md:text-8xl font-display font-bold mb-6 bg-gradient-to-r from-qbase-text to-qbase-accent bg-clip-text text-transparent">
                        The Personal Context Layer
                    </h1>
                </motion.div>

                <motion.p
                    className="text-xl md:text-2xl text-qbase-text-dim mb-10 font-light"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4, duration: 0.8 }}
                >
                    Write once. Answer forever. <br className="hidden md:block" />
                    The API for your digital self.
                </motion.p>

                <motion.div
                    className="flex flex-col sm:flex-row gap-4 justify-center items-center"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.8, duration: 0.8 }}
                >
                    <Link
                        to="/claim"
                        className="px-8 py-4 bg-qbase-accent text-white rounded-full font-bold text-lg hover:shadow-[0_0_20px_rgba(125,211,252,0.5)] transition-all transform hover:scale-105"
                    >
                        Claim Your Context
                    </Link>
                    <Link
                        to="/about"
                        className="px-8 py-4 border border-qbase-text-dim/30 text-qbase-text rounded-full font-medium hover:bg-qbase-text/5 transition-all"
                    >
                        Read Philosophy
                    </Link>
                </motion.div>
            </div>
        </section>
    );
}

function ProblemSection() {
    return (
        <section className="py-32 px-4 relative overflow-hidden">
            <div className="max-w-7xl mx-auto grid md:grid-cols-2 gap-16 items-center">
                <motion.div
                    initial={{ opacity: 0, x: -50 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.8 }}
                    className="order-2 md:order-1"
                >
                    <div className="relative p-8 rounded-3xl bg-qbase-ivory/50 backdrop-blur-sm border border-qbase-slate/50">
                        <h3 className="text-2xl font-bold mb-6 text-qbase-text">The Old World</h3>
                        <div className="space-y-4">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/50 border border-qbase-slate/30">
                                    <div className="w-10 h-10 rounded-full bg-gray-200 animate-pulse" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-3/4 bg-gray-200 rounded animate-pulse" />
                                        <div className="h-3 w-1/2 bg-gray-200 rounded animate-pulse" />
                                    </div>
                                    <div className="text-xs text-gray-400">Disconnected</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, x: 50 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.8 }}
                    className="order-1 md:order-2"
                >
                    <h2 className="text-4xl md:text-5xl font-bold mb-6 text-qbase-text">
                        Stop Repeating Yourself
                    </h2>
                    <p className="text-xl text-qbase-text-dim leading-relaxed mb-8">
                        Your identity is scattered across dozens of platforms, locked in silos.
                        Every new AI starts from zero. Qbase unifies your digital self into a
                        single, portable, encrypted source of truth.
                    </p>
                    <ul className="space-y-4 text-qbase-text">
                        <li className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-qbase-accent" />
                            <span>Identity Sovereignty</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-qbase-accent" />
                            <span>Cross-Platform Portability</span>
                        </li>
                        <li className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-qbase-accent" />
                            <span>Zero-Knowledge Privacy</span>
                        </li>
                    </ul>
                </motion.div>
            </div>
        </section>
    );
}

function MechanicsSection() {
    return (
        <section className="py-32 px-4 bg-qbase-ivory/30">
            <div className="max-w-7xl mx-auto text-center mb-20">
                <h2 className="text-4xl md:text-5xl font-bold mb-6 text-qbase-text">Privacy as Architecture</h2>
                <p className="text-xl text-qbase-text-dim max-w-2xl mx-auto">
                    Built on Nillion. Granular control over your digital soul.
                </p>
            </div>

            <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
                {[
                    {
                        icon: Eye,
                        title: "Public",
                        desc: "For reputation. Show the world who you are.",
                        color: "text-blue-500",
                        bg: "bg-blue-500/10"
                    },
                    {
                        icon: Ghost,
                        title: "Anonymous",
                        desc: "For truth. Share hot takes without the blowback.",
                        color: "text-purple-500",
                        bg: "bg-purple-500/10"
                    },
                    {
                        icon: Shield,
                        title: "Private",
                        desc: "For agents only. Encrypted vaults for sensitive context.",
                        color: "text-emerald-500",
                        bg: "bg-emerald-500/10"
                    }
                ].map((card, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 30 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: i * 0.2, duration: 0.6 }}
                        className="p-8 rounded-3xl bg-white/50 backdrop-blur-sm border border-qbase-slate/50 hover:border-qbase-accent/50 transition-all hover:scale-105 group"
                    >
                        <div className={`w-14 h-14 ${card.bg} ${card.color} rounded-2xl flex items-center justify-center mb-6`}>
                            <card.icon size={28} />
                        </div>
                        <h3 className="text-2xl font-bold mb-4 text-qbase-text">{card.title}</h3>
                        <p className="text-qbase-text-dim leading-relaxed">
                            {card.desc}
                        </p>
                    </motion.div>
                ))}
            </div>
        </section>
    );
}

function SociologySection() {
    return (
        <section className="py-32 px-4 relative">
            <div className="absolute inset-0 bg-qbase-slate/10 -skew-y-3 transform origin-top-left scale-110 z-0" />
            <div className="relative z-10 max-w-7xl mx-auto grid md:grid-cols-2 gap-16 items-center">
                <div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-6 text-qbase-text">
                        The Collective Mind
                    </h2>
                    <p className="text-xl text-qbase-text-dim mb-8 leading-relaxed">
                        Your answers contribute to a public good. We're mapping human beliefs at scale—without surveillance.
                        Aggregate insights belong to everyone, not just ad networks.
                    </p>
                    <div className="flex gap-4">
                        <div className="p-4 rounded-xl bg-white/20 border border-qbase-text/10">
                            <div className="text-3xl font-bold text-qbase-accent mb-1">42%</div>
                            <div className="text-sm">believe AI is conscious</div>
                        </div>
                        <div className="p-4 rounded-xl bg-white/20 border border-qbase-text/10">
                            <div className="text-3xl font-bold text-qbase-accent mb-1">8,210</div>
                            <div className="text-sm">Human verified nodes</div>
                        </div>
                    </div>
                </div>

                <div className="relative h-[400px] rounded-3xl overflow-hidden bg-qbase-text/5 border border-qbase-text/10">
                    {/* Placeholder for Data Viz */}
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                            <Globe className="w-16 h-16 text-qbase-text-dim mx-auto mb-4 opacity-50" />
                            <p className="text-sm uppercase tracking-widest text-qbase-text-dim">Live Data Stream</p>
                        </div>
                    </div>

                    {/* Animated random bars */}
                    <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between px-4 pb-4 h-full opacity-20">
                        {[...Array(20)].map((_, i) => (
                            <motion.div
                                key={i}
                                className="w-4 bg-qbase-accent rounded-t-full"
                                animate={{ height: ['10%', '60%', '30%', '80%', '20%'] }}
                                transition={{ duration: 2 + Math.random() * 2, repeat: Infinity, ease: "easeInOut" }}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

function AgentSection() {
    return (
        <section className="py-32 px-4 text-center">
            <div className="max-w-4xl mx-auto">
                <div className="w-16 h-16 bg-qbase-accent/20 text-qbase-accent rounded-full flex items-center justify-center mx-auto mb-8">
                    <Brain size={32} />
                </div>
                <h2 className="text-4xl md:text-5xl font-bold mb-6 text-qbase-text">
                    Context is King
                </h2>
                <p className="text-xl text-qbase-text-dim mb-12 max-w-2xl mx-auto">
                    Give your AI a soul. A permissioned context layer that any authorized AI can access.
                    No more cold starts.
                </p>

                <div className="relative max-w-2xl mx-auto bg-white/80 dark:bg-slate-900/80 rounded-2xl shadow-2xl overflow-hidden border border-qbase-slate/50">
                    <div className="p-4 border-b border-qbase-slate/30 bg-qbase-slate/10 flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-red-400" />
                        <div className="w-3 h-3 rounded-full bg-yellow-400" />
                        <div className="w-3 h-3 rounded-full bg-green-400" />
                        <span className="ml-4 text-xs text-qbase-text-dim font-mono">My Agent</span>
                    </div>
                    <div className="p-6 space-y-4 text-left font-mono text-sm">
                        <div className="bg-qbase-slate/20 p-3 rounded-lg rounded-tl-none inline-block max-w-[80%]">
                            Plan a weekend trip for me.
                        </div>
                        <div className="text-qbase-text-dim text-xs py-2 text-center">
                            * Retrieving context from Qbase... found 12 relevant nodes *
                        </div>
                        <div className="bg-qbase-accent/10 text-qbase-accent p-3 rounded-lg rounded-tr-none ml-auto inline-block max-w-[90%] border border-qbase-accent/20">
                            I know you prefer quiet nature spots over cities, have a budget of $500,
                            and love hiking. I found a cabin in the Catskills that fits your criteria...
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function Footer() {
    return (
        <footer className="py-12 px-4 border-t border-qbase-slate/30 bg-qbase-ivory/30">
            <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
                <div className="flex items-center gap-2">
                    <Logo className="w-8 h-8" />
                    <span className="font-bold text-xl text-qbase-text">Qbase</span>
                </div>
                <div className="flex gap-8 text-qbase-text-dim text-sm">
                    <Link to="/about" className="hover:text-qbase-accent transition-colors">Manifesto</Link>
                    <a href="#" className="hover:text-qbase-accent transition-colors">Docs</a>
                    <a href="#" className="hover:text-qbase-accent transition-colors">Twitter</a>
                    <a href="#" className="hover:text-qbase-accent transition-colors">Farcaster</a>
                </div>
                <div className="text-xs text-qbase-text-dim/50">
                    Secured by Nillion • Built on Base
                </div>
            </div>
        </footer>
    );
}

export default function HomePage() {
    return (
        <div className="min-h-screen bg-transparent">
            <Header />
            <HeroSection />
            <ProblemSection />
            <MechanicsSection />
            <SociologySection />
            <AgentSection />
            <Footer />
        </div>
    );
}
