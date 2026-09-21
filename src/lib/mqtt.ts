const TOPIC_COLORS = [
  "#38bdf8",
  "#a855f7",
  "#f97316",
  "#14b8a6",
  "#eab308",
  "#ec4899",
  "#22c55e",
  "#f43f5e",
];

export function mqttTopicMatches(filter: string, topic: string): boolean {
  if (!filter) return true;
  if (filter === topic) return true;
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let i = 0; i < filterParts.length; i += 1) {
    const part = filterParts[i];
    if (part === "#") return i === filterParts.length - 1;
    if (topicParts[i] === undefined) return false;
    if (part !== "+" && part !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

export function mqttTopicColor(topic: string): string {
  let hash = 0;
  for (let i = 0; i < topic.length; i += 1) {
    hash = (hash * 33 + topic.charCodeAt(i)) >>> 0;
  }
  return TOPIC_COLORS[hash % TOPIC_COLORS.length] ?? TOPIC_COLORS[0];
}

export function isMqttWildcard(topic: string): boolean {
  return topic.includes("#") || topic.includes("+");
}
