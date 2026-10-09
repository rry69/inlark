import { useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Archive,
  ChevronDown,
  Folder,
  Inbox,
  Mail,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  SquarePen,
  Settings as SettingsIcon,
  ShieldX,
  Star,
  Trash2,
  FileText,
  WifiOff,
} from '@inlark/ui/icons'
import { Button, Dropdown, IconButton, MenuItem } from '@inlark/ui'
import { Wordmark } from '@inlark/ui/components/wordmark'
import type { Account, Mailbox, View } from '@inlark/core'
import appIcon from '../../../resources/icon-mark.svg?no-inline'
import { AccountMark } from './AccountMark'
import { DRAG_MIME, type DropTarget } from './ConversationList'
import { ShortcutHint, useShortcutText, type ShortcutId } from './shortcuts'

export const views: { id: View; title: string; icon: typeof Inbox; shortcut?: ShortcutId }[] = [
  { id: 'inbox', title: 'Inbox', icon: Inbox, shortcut: 'goInbox' },
  { id: 'starred', title: 'Starred', icon: Star, shortcut: 'goStarred' },
  { id: 'sent', title: 'Sent', icon: Send, shortcut: 'goSent' },
  { id: 'drafts', title: 'Drafts', icon: FileText, shortcut: 'goDrafts' },
  { id: 'archive', title: 'Archive', icon: Archive, shortcut: 'goArchive' },
  { id: 'all', title: 'All Mail', icon: Mail, shortcut: 'goAll' },
  { id: 'junk', title: 'Spam', icon: ShieldX, shortcut: 'goSpam' },
  { id: 'trash', title: 'Trash', icon: Trash2, shortcut: 'goTrash' },
]
const statusLabel: Record<Account['status'], string> = {
  connecting: 'connecting',
  connected: 'connected',
  offline: 'offline',
  authentication: 'needs sign-in',
  error: 'unavailable',
}
export function Sidebar({
  accounts,
  boxesByAccount,
  route,
  view,
  draftCount,
  hasServerDrafts,
  sendingIssues,
  unreadCount,
  collapsed,
  hiddenViews,
  hideFolders,
  onToggleCollapsed,
  onSearch,
  onCompose,
  onNavigate,
  onSettings,
  onFolderAction,
  onDropConversations,
}: {
  accounts: Account[]
  boxesByAccount: Record<string, Mailbox[]>
  route: { account?: string; folder?: string; q?: string }
  view: View
  draftCount: number
  hasServerDrafts: boolean
  /** Sends that still need a decision, shown in Drafts. */
  sendingIssues: number
  unreadCount: number
  collapsed: boolean
  hiddenViews?: View[]
  hideFolders?: boolean
  onToggleCollapsed: () => void
  onSearch: () => void
  onCompose: () => void
  onNavigate: (next: { view: View; account?: string; folder?: string }) => void
  onSettings: (tab: 'accounts' | 'general') => void
  /** A dragged conversation landed on a sidebar destination. */
  onDropConversations?: (target: DropTarget, keys: string[]) => void
  onFolderAction: (
    operation: 'create' | 'rename' | 'delete',
    accountId: string,
    folder?: Mailbox,
  ) => void
}) {
  const keys = useShortcutText()
  const go = onNavigate
  // Transient connecting states need no banner; only show accounts that need attention.
  const unavailable = accounts.filter((a) => a.status !== 'connected' && a.status !== 'connecting')
  const statusText =
    unavailable.length === 1
      ? unavailable[0].name + ' ' + statusLabel[unavailable[0].status]
      : unavailable.length + ' accounts unavailable'
  const sendingText =
    sendingIssues === 1
      ? '1 sent message needs attention'
      : sendingIssues + ' sent messages need attention'
  const [foldersExpanded, setFoldersExpanded] = useState(
    () => localStorage.getItem('sidebar-folders-expanded') !== 'false',
  )
  useEffect(() => {
    localStorage.setItem('sidebar-folders-expanded', String(foldersExpanded))
  }, [foldersExpanded])
  /** Only these views accept a dragged conversation; Starred/Sent/Drafts/All do not. */
  const dropViews: ReadonlySet<View> = new Set(['inbox', 'archive', 'junk', 'trash'])
  const dropKey = (target: DropTarget) =>
    target.kind +
    ':' +
    (target.kind === 'folder' ? target.mailboxId : target.view) +
    ':' +
    (target.accountId || '')
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const droppable = (target: DropTarget, enabled: boolean) => {
    if (!enabled || !onDropConversations) return {}
    const key = dropKey(target)
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(DRAG_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(key)
      },
      onDragLeave: () => setDropTarget((current) => (current === key ? null : current)),
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        setDropTarget(null)
        try {
          const keys = JSON.parse(event.dataTransfer.getData(DRAG_MIME)) as unknown
          if (Array.isArray(keys) && keys.length && keys.every((k) => typeof k === 'string'))
            onDropConversations(target, keys)
        } catch {
          // Drops from outside the list carry no conversation keys; ignore them.
        }
      },
    }
  }
  const dropClass = (target: DropTarget, enabled: boolean) =>
    enabled && onDropConversations && dropTarget === dropKey(target) ? ' drop-target' : ''
  const hidden = new Set(hiddenViews || [])
  const visibleViews = views.filter((v) => !hidden.has(v.id))
  /** Custom folders merged across accounts; narrows to the header-filtered account. */
  const unifiedFolders = useMemo(() => {
    const all: { box: Mailbox; account: Account }[] = []
    for (const account of accounts) {
      if (route.account && account.id !== route.account) continue
      for (const box of boxesByAccount[account.id] || []) {
        if (box.role) continue
        all.push({ box, account })
      }
    }
    return all.sort((a, b) =>
      a.box.name.localeCompare(b.box.name, undefined, { sensitivity: 'base' }),
    )
  }, [accounts, boxesByAccount, route.account])
  const showFolders = !hideFolders
  const singleTargetAccount =
    route.account || (accounts.length === 1 ? accounts[0].id : undefined)
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img
          className="brand-mark"
          src={appIcon}
          alt={collapsed ? 'Inlark' : ''}
          width={24}
          height={24}
        />
        {!collapsed && <Wordmark className="brand-wordmark" />}
      </div>
      <div className="sidebar-tools">
        <IconButton label="Search and commands" shortcut={keys('commandMenu')} onClick={onSearch}>
          <Search size={14} />
        </IconButton>
        <IconButton
          className="sidebar-compose"
          label="Compose"
          shortcut={keys('compose')}
          onClick={onCompose}
        >
          <SquarePen size={16} />
        </IconButton>
      </div>
      <div className="sidebar-scroll">
        <nav className="main-nav" aria-label="Mail">
          {visibleViews
            .filter(
              (v) =>
                v.id !== 'drafts' ||
                draftCount > 0 ||
                hasServerDrafts ||
                sendingIssues > 0 ||
                view === 'drafts',
            )
            .map((v) => (
              <button
                key={v.id}
                title={
                  v.title +
                  (route.account ? ' · filtered to account' : '') +
                  (v.id === 'inbox' ? ' · ' + unreadCount + ' unread' : '') +
                  (v.shortcut && keys(v.shortcut) ? ' · ' + keys(v.shortcut) : '')
                }
                aria-current={view === v.id && !route.folder && !route.q ? 'page' : undefined}
                className={
                  'nav-item ' +
                  (v.id === 'archive' ? 'nav-secondary-start ' : '') +
                  (view === v.id && !route.folder && !route.q ? 'active' : '') +
                  dropClass({ kind: 'view', view: v.id }, dropViews.has(v.id))
                }
                onClick={() =>
                  route.account ? go({ view: v.id, account: route.account }) : go({ view: v.id })
                }
                {...droppable({ kind: 'view', view: v.id }, dropViews.has(v.id))}
              >
                <v.icon size={16} strokeWidth={1.65} />
                {!collapsed && (
                  <>
                    <span>{v.title}</span>
                    {v.id === 'drafts' && draftCount > 0 && <small>{draftCount}</small>}
                    {v.id === 'inbox' && unreadCount > 0 && (
                      <small>{unreadCount.toLocaleString()}</small>
                    )}
                  </>
                )}
              </button>
            ))}
        </nav>
        {showFolders && (
          <div className="sidebar-section-label">
            {!collapsed && (
              <button
                className="sidebar-section-toggle"
                aria-expanded={foldersExpanded}
                onClick={() => setFoldersExpanded((open) => !open)}
              >
                <span>Folders</span>
                <ChevronDown size={12} className={foldersExpanded ? '' : 'closed'} />
              </button>
            )}
            {!collapsed &&
              (singleTargetAccount ? (
                <IconButton
                  label="New folder"
                  title="New folder"
                  onClick={() => onFolderAction('create', singleTargetAccount)}
                >
                  <Plus size={13} />
                </IconButton>
              ) : (
                <Dropdown
                  trigger={
                    <IconButton label="New folder" title="New folder">
                      <Plus size={13} />
                    </IconButton>
                  }
                >
                  {accounts.map((a) => (
                    <MenuItem key={a.id} onClick={() => onFolderAction('create', a.id)}>
                      {a.name}
                    </MenuItem>
                  ))}
                </Dropdown>
              ))}
          </div>
        )}
        {showFolders && (foldersExpanded || collapsed) && (
          <nav className="folder-nav" aria-label="Folders">
            {unifiedFolders.length === 0 && !collapsed && (
              <div className="account-no-folders" aria-hidden="true">
                <span>No custom folders</span>
              </div>
            )}
            {unifiedFolders.map(({ box: b, account: a }) => {
              const active = route.folder === b.id && route.account === a.id
              return (
                <div className="folder-nav-row" key={a.id + ':' + b.id}>
                  <button
                    className={
                      'nav-item ' +
                      (active ? 'active' : '') +
                      dropClass({ kind: 'folder', accountId: a.id, mailboxId: b.id }, true)
                    }
                    aria-current={active ? 'page' : undefined}
                    title={
                      b.name +
                      ' · ' +
                      a.name +
                      (b.unreadEmails > 0 ? ' · ' + b.unreadEmails + ' unread' : '')
                    }
                    aria-label={b.name + ', ' + a.name}
                    onClick={() => go({ view: 'all', account: a.id, folder: b.id })}
                    {...droppable({ kind: 'folder', accountId: a.id, mailboxId: b.id }, true)}
                  >
                    <Folder size={16} strokeWidth={1.65} />
                    {!collapsed && (
                      <>
                        <span>{b.name}</span>
                        {!route.account && accounts.length > 1 && (
                          <AccountMark account={a} size={14} />
                        )}
                        {b.unreadEmails > 0 && <small>{b.unreadEmails.toLocaleString()}</small>}
                      </>
                    )}
                  </button>
                  {!collapsed && (
                    <Dropdown
                      trigger={
                        <Button variant="ghost" size="icon" aria-label={'Manage ' + b.name}>
                          <MoreHorizontal size={13} />
                        </Button>
                      }
                    >
                      <MenuItem
                        disabled={!b.rights.mayRename}
                        onClick={() => onFolderAction('rename', a.id, b)}
                      >
                        Rename folder
                      </MenuItem>
                      <MenuItem
                        danger
                        disabled={!b.rights.mayDelete}
                        onClick={() => onFolderAction('delete', a.id, b)}
                      >
                        Delete folder
                      </MenuItem>
                    </Dropdown>
                  )}
                </div>
              )
            })}
          </nav>
        )}
      </div>
      <div className="sidebar-bottom">
        {sendingIssues > 0 && (
          <button
            className={'nav-item sidebar-sending' + (view === 'drafts' ? ' active' : '')}
            title={sendingText + ' · review in Drafts'}
            aria-label={sendingText + '. Review in Drafts.'}
            onClick={() => go({ view: 'drafts' })}
          >
            <Send size={15} strokeWidth={1.65} />
            {!collapsed && (
              <>
                <span>Send status</span>
                <small>{sendingIssues}</small>
              </>
            )}
          </button>
        )}
        {unavailable.length > 0 && (
          <button
            className="nav-item sidebar-status"
            title={unavailable.map((a) => a.email + ' · ' + statusLabel[a.status]).join('\n')}
            aria-label={statusText}
            onClick={() => onSettings('accounts')}
          >
            <WifiOff size={15} strokeWidth={1.65} />
            {!collapsed && <span>{statusText}</span>}
          </button>
        )}
        <div className="sidebar-footer">
          {collapsed && (
            <IconButton
              label="Expand sidebar"
              shortcut={keys('toggleSidebar')}
              onClick={onToggleCollapsed}
            >
              <PanelLeftOpen size={15} />
            </IconButton>
          )}
          <button
            className="nav-item"
            title={'Settings' + (keys('settings') ? ' · ' + keys('settings') : '')}
            aria-label="Settings"
            onClick={() => onSettings('general')}
          >
            <SettingsIcon size={16} strokeWidth={1.65} />
            {!collapsed && (
              <>
                <span>Settings</span>
                <ShortcutHint id="settings" />
              </>
            )}
          </button>
          {!collapsed && (
            <IconButton
              label="Collapse sidebar"
              shortcut={keys('toggleSidebar')}
              onClick={onToggleCollapsed}
            >
              <PanelLeftClose size={15} />
            </IconButton>
          )}
        </div>
      </div>
    </aside>
  )
}
