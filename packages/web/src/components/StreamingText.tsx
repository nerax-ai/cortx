interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
  return (
    <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
      <pre className="whitespace-pre-wrap text-gray-100 text-sm font-sans">{text}</pre>
      <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1" />
    </div>
  );
}
