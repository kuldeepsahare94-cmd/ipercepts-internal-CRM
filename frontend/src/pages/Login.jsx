import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import LampMascot from '../components/LampMascot';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [lit, setLit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLit(true);        // light turns on immediately on click, no waiting animation
    setSubmitting(true);
    try {
      const { token, user } = await api.login(username, password);
      login(token, user);
      navigate('/');      // straight in, no artificial delay
    } catch (err) {
      setLit(false);
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #2A1B4D 0%, #1a1030 60%, #120b22 100%)' }}>
      <div className="absolute inset-0 opacity-[0.06]" style={{
        backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)',
        backgroundSize: '28px 28px',
      }} />

      <div className="relative flex items-center gap-0 bg-transparent">
        {/* Mascot panel */}
        <div className="hidden sm:flex flex-col items-center justify-center w-56 py-10">
          <LampMascot status={lit ? 'success' : 'idle'} />
          <p className="text-white/40 text-xs mt-4 text-center px-4">
            {lit ? 'Welcome back!' : 'Light up your placement CRM.'}
          </p>
        </div>

        {/* Card */}
        <form onSubmit={submit}
          className="w-full max-w-sm mx-4 bg-white/95 backdrop-blur rounded-2xl p-8 shadow-2xl">
          <h1 className="font-display text-2xl font-semibold text-ink text-center" style={{ fontFamily: 'var(--font-display)' }}>
            Welcome Back
          </h1>
          <p className="text-center text-slate-400 text-xs mt-1 mb-6">Sign in to your placement CRM</p>

          <label className="text-xs font-medium text-slate-500 block mb-1">Username</label>
          <input required autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            className="w-full border border-line rounded-lg px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber" />

          <label className="text-xs font-medium text-slate-500 block mb-1">Password</label>
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            className="w-full border border-line rounded-lg px-3 py-2.5 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber" />

          {error && <p className="text-warn text-xs mt-2">{error}</p>}

          <button type="submit" disabled={submitting}
            className="w-full text-white text-sm font-semibold py-2.5 rounded-lg mt-5 transition-colors disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #A855F7, #7C3AED)' }}>
            Login
          </button>

          <p className="text-center mt-4">
            <button type="button" onClick={() => alert('Contact your admin to reset your password.')}
              className="text-xs text-slate-400 hover:text-ink">
              Forgot Password?
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
