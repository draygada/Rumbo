import { useChatStore, useChatList } from './chatStore';
import styles from './ChatHistory.module.css';

interface ChatHistoryProps {
  open: boolean;
  onClose: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 0) return 'just now';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < minute) return 'just now';
  if (diff < hour) {
    const m = Math.floor(diff / minute);
    return `${m}m ago`;
  }
  if (diff < day) {
    const h = Math.floor(diff / hour);
    return `${h}h ago`;
  }
  if (diff < 2 * day) return 'yesterday';
  if (diff < week) {
    const d = Math.floor(diff / day);
    return `${d}d ago`;
  }

  const date = new Date(timestamp);
  const now2 = new Date(now);
  const sameYear = date.getFullYear() === now2.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export default function ChatHistory({ open, onClose }: ChatHistoryProps) {
  const chats = useChatList();
  const loadChat = useChatStore((s) => s.loadChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const newChat = useChatStore((s) => s.newChat);

  if (!open) return null;

  const handleNewChat = () => {
    newChat();
    onClose();
  };

  const handleLoad = (id: string) => {
    loadChat(id);
    onClose();
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteChat(id);
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Your chats"
      >
        <header className={styles.header}>
          <h2 className={styles.headerTitle}>Your chats</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close chat history"
          >
            ×
          </button>
        </header>

        <button type="button" className={styles.newChatButton} onClick={handleNewChat}>
          + New Chat
        </button>

        <div className={styles.body}>
          {chats.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyBody}>No past chats yet</p>
            </div>
          ) : (
            <ul className={styles.list}>
              {chats.map((chat) => (
                <li key={chat.id}>
                  <div
                    className={styles.row}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleLoad(chat.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleLoad(chat.id);
                      }
                    }}
                  >
                    <div className={styles.rowText}>
                      <span className={styles.rowTitle}>
                        {chat.title || 'Untitled chat'}
                      </span>
                      <span className={styles.rowTime}>
                        {formatRelativeTime(chat.updatedAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.deleteButton}
                      onClick={(e) => handleDelete(e, chat.id)}
                      aria-label={`Delete chat: ${chat.title || 'Untitled chat'}`}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
