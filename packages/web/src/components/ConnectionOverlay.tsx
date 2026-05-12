import { useState } from 'react';

interface ConnectionOverlayProps {
  onConnect: () => void;
}

export function ConnectionOverlay({ onConnect }: ConnectionOverlayProps) {
  const [apiKey, setApiKey] = useState('');

  return (
    <div className="h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-gray-900 rounded-lg p-8 w-96 shadow-xl">
        <h1 className="text-2xl font-bold text-white mb-6">Cortx</h1>
        <label className="block text-sm text-gray-400 mb-2">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your API key"
          className="w-full bg-gray-800 text-white rounded px-3 py-2 mb-4 outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={onConnect}
          disabled={!apiKey}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded px-4 py-2 font-medium"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
