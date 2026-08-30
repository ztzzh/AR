import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "腕间试戴 · AR 首饰",
  description: "面向手链与手表的手机 Web AR 试戴技术原型",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
