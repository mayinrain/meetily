import Link from 'next/link';
export default function NotFound() {
  return <div className="flex h-screen flex-col items-center justify-center gap-4 bg-white">
    <p className="text-gray-700">没有找到这个页面。</p>
    <Link href="/" className="text-blue-700 underline">返回会议记录</Link>
  </div>;
}
