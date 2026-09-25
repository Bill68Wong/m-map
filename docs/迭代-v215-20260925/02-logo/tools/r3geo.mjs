// 第三轮几何核算：钉帽圆心 (48,16) R=8；尖端 tipY 变化；切线点推导
const C = { x: 48, y: 16 }, R = 8;
function pin(tipY) {
  const d = tipY - C.y;
  const ang = Math.acos(R / d); // 圆心→切点夹角
  const s = Math.sin(ang), c = Math.cos(ang);
  const right = { x: C.x + R * s, y: C.y + R * c };
  const left = { x: C.x - R * s, y: C.y + R * c };
  const f = (n) => +n.toFixed(2);
  return `M${f(left.x)} ${f(left.y)} L48 ${tipY} L${f(right.x)} ${f(right.y)} A8 8 0 1 0 ${f(left.x)} ${f(left.y)} Z`;
}
console.log("tip52 (校验原始A):", pin(52));
console.log("tip56 (长)      :", pin(56));
console.log("tip46 (短)      :", pin(46));

// 留缝核算：路线终点 (37.5,26.5) → 钉帽圆边
const end = { x: 37.5, y: 26.5 };
const dc = Math.hypot(end.x - C.x, end.y - C.y);
console.log("routeEnd→headCenter:", dc.toFixed(2), "| 圆边→端点:", (dc - R).toFixed(2));
const cap = { x: end.x + 3.25 * 0.7071, y: end.y - 3.25 * 0.7071 };
const dc2 = Math.hypot(cap.x - C.x, cap.y - C.y);
console.log("可视缝隙 ≈", (dc2 - R).toFixed(2), "units");
console.log("左竖笔画底缘 y =", (48 + 3.25).toFixed(2), "| 起点站环外缘 y =", (48 + 4.6 + 1.1).toFixed(2));
