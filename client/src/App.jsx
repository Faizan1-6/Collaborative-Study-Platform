import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
} from 'firebase/auth';
import { firebaseAuth, firebaseAuthError, prepareFirebaseAuth } from './firebase.js';

const API = (
  import.meta.env.DEV
    ? ''
    : import.meta.env.VITE_API_BASE_URL || ''
).replace(/\/+$/, '');
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function getSavedRoom() {
  const savedRoom = window.localStorage.getItem('studysphere-room');
  return savedRoom && ROOM_ID_PATTERN.test(savedRoom) ? savedRoom : 'study-room-1';
}

async function readApiResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server returned an invalid response (${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const navigation = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'room', label: 'Study Room', icon: 'users' },
  { id: 'notes', label: 'Shared Notes', icon: 'note' },
  { id: 'assistant', label: 'AI Assistant', icon: 'sparkle' },
  { id: 'resources', label: 'Resources', icon: 'folder' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function Icon({ name, size = 20 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
    sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z" /></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 10h18" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2Z" /></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function Brand({ compact = false }) {
  return (
    <div className={`brand${compact ? ' brand-compact' : ''}`}>
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
      {!compact && <span className="brand-name">Study<span>Sphere</span></span>}
    </div>
  );
}

function App() {
  const [activePage, setActivePage] = useState('overview');
  const [room, setRoom] = useState(getSavedRoom);
  const [roomInput, setRoomInput] = useState(getSavedRoom);
  const [notes, setNotes] = useState('');
  const [notesStatus, setNotesStatus] = useState('loading');
  const [notesError, setNotesError] = useState('');
  const [notesLoadError, setNotesLoadError] = useState(false);
  const [notesReload, setNotesReload] = useState(0);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [roomNotice, setRoomNotice] = useState('');
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const [roomCopied, setRoomCopied] = useState(false);
  const [resources, setResources] = useState([]);
  const [resourcesReload, setResourcesReload] = useState(0);
  const [resourcesStatus, setResourcesStatus] = useState('loading');
  const [resourcesError, setResourcesError] = useState('');
  const [resourcesNotice, setResourcesNotice] = useState('');
  const [selectedResource, setSelectedResource] = useState(null);
  const [previewingResourceId, setPreviewingResourceId] = useState('');
  const [isUploadingResource, setIsUploadingResource] = useState(false);
  const [deletingResourceId, setDeletingResourceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('groq');
  const [answer, setAnswer] = useState(null);
  const [isAsking, setIsAsking] = useState(false);
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [serverHealth, setServerHealth] = useState(null);
  const [healthError, setHealthError] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardStatus, setDashboardStatus] = useState('loading');
  const [dashboardError, setDashboardError] = useState('');
  const [dashboardReload, setDashboardReload] = useState(0);
  const [authUser, setAuthUser] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });
  const [authNotice, setAuthNotice] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const saveInProgress = useRef(false);
  const askInProgress = useRef(false);
  const uploadInProgress = useRef(false);
  const roomActionInProgress = useRef(false);
  const notesValue = useRef('');
  const savedNotesValue = useRef('');
  const pendingNotesSave = useRef(null);
  const activeRoom = useRef(room);

  useEffect(() => {
    window.localStorage.setItem('studysphere-room', room);
  }, [room]);

  useEffect(() => {
    fetch(`${API}/api/health`)
      .then(readApiResponse)
      .then((health) => {
        setServerHealth(health);
        setHealthError('');
      })
      .catch((error) => setHealthError(error.message || 'Unable to check backend status.'));
  }, []);

  useEffect(() => {
    let isCurrent = true;
    setDashboardStatus('loading');
    fetch(`${API}/api/dashboard/stats`, { credentials: 'include' })
      .then(readApiResponse)
      .then((data) => {
        if (!isCurrent) return;
        if (!data.stats || !Array.isArray(data.activity)) throw new Error('The server returned invalid dashboard statistics.');
        setDashboard(data);
        setDashboardStatus('loaded');
        setDashboardError('');
      })
      .catch((error) => {
        if (!isCurrent) return;
        setDashboardStatus('error');
        setDashboardError(error.message || 'Unable to load dashboard statistics.');
      });
    return () => {
      isCurrent = false;
    };
  }, [dashboardReload, authUser?.id]);

  useEffect(() => {
    let isCurrent = true;
    const url = new URL(window.location.href);
    const verificationResult = url.searchParams.get('verified');
    const resetToken = url.searchParams.get('reset');
    fetch(`${API}/api/auth/me`, { credentials: 'include' })
      .then(readApiResponse)
      .then((data) => {
        if (isCurrent) {
          setAuthUser(data.user || null);
          if (data.user) {
            setAuthForm((current) => ({ ...current, name: data.user.name, email: data.user.email }));
            if (!verificationResult && !resetToken) setAuthMode('profile');
          }
        }
      })
      .catch((error) => {
        if (isCurrent) setAuthError(error.message || 'Unable to load your account.');
      });

    if (verificationResult) {
      setActivePage('settings');
      setAuthMode('login');
      if (verificationResult === '1') {
        setAuthNotice('Email verified. You can now sign in.');
      } else {
        setAuthError('The verification link is invalid, expired, or already used. Request a new verification email.');
      }
      url.searchParams.delete('verified');
      window.history.replaceState({}, '', url.toString());
    } else if (resetToken) {
      setAuthMode('reset');
      setActivePage('settings');
      if (resetToken === 'invalid') {
        setAuthError('The password reset link is invalid, expired, or already used.');
      } else {
        setAuthNotice('');
      }
      url.searchParams.delete('reset');
      window.history.replaceState({}, '', url.toString());
    }
    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    activeRoom.current = room;
    let isCurrentRoom = true;
    let receivedSocketNotesUpdate = false;
    setNotes('');
    notesValue.current = '';
    savedNotesValue.current = '';
    setNotesError('');
    setNotesLoadError(false);
    setNotesStatus('loading');
    setSocketStatus('connecting');
    setRoomError('');

    const socket = io(API, { withCredentials: true });
    socket.on('connect', () => {
      if (!isCurrentRoom) return;
      socket.emit('room:join', room, (result) => {
        if (!isCurrentRoom) return;
        if (!result?.ok) {
          setSocketStatus('disconnected');
          setRoomError(result?.error || 'Unable to join the room. Please reconnect and try again.');
          return;
        }
        setSocketStatus('connected');
        setRoomError('');
      });
    });
    socket.on('disconnect', () => {
      if (isCurrentRoom) {
        setSocketStatus('disconnected');
        setRoomError('The real-time connection was lost. Check the backend and reconnect.');
      }
    });
    socket.on('connect_error', () => {
      if (isCurrentRoom) {
        setSocketStatus('disconnected');
        setRoomError('Could not connect to the backend real-time service.');
      }
    });
    socket.on('notes:update', (text) => {
      if (!isCurrentRoom) return;
      receivedSocketNotesUpdate = true;
      refreshDashboard();
      if (pendingNotesSave.current?.room === room && pendingNotesSave.current.text === text) return;
      if (notesValue.current !== savedNotesValue.current) {
        setNotesStatus('unsaved');
        setNotesError('A collaborator saved notes while your draft was unsaved. Your draft was preserved; save to replace the shared notes.');
        return;
      }
      notesValue.current = text;
      savedNotesValue.current = text;
      setNotes(text);
      setNotesStatus('synced');
      setNotesError('');
      setNotesLoadError(false);
    });
    socket.on('resources:update', () => {
      if (isCurrentRoom) {
        setResourcesReload((current) => current + 1);
        refreshDashboard();
      }
    });

    fetch(`${API}/api/notes/${encodeURIComponent(room)}`)
      .then(readApiResponse)
      .then((data) => {
        if (!isCurrentRoom || receivedSocketNotesUpdate) return;
        const text = typeof data.text === 'string' ? data.text : '';
        notesValue.current = text;
        savedNotesValue.current = text;
        setNotes(text);
        setNotesStatus('synced');
        setNotesLoadError(false);
      })
      .catch((error) => {
        if (!isCurrentRoom || receivedSocketNotesUpdate) return;
        setNotesStatus('error');
        setNotesLoadError(true);
        setNotesError(error.message || 'Unable to load notes. Check your connection and try again.');
      });

    return () => {
      isCurrentRoom = false;
      socket.disconnect();
    };
  }, [room, notesReload]);

  useEffect(() => {
    let isCurrentRoom = true;
    setResources([]);
    setSelectedResource(null);
    setResourcesError('');
    setResourcesNotice('');
    setResourcesStatus('loading');

    fetch(`${API}/api/resources/${encodeURIComponent(room)}`)
      .then(readApiResponse)
      .then((data) => {
        if (!isCurrentRoom) return;
        if (!Array.isArray(data.resources)) throw new Error('The server returned an invalid resources list.');
        setResources(data.resources);
        setResourcesStatus('loaded');
      })
      .catch((error) => {
        if (!isCurrentRoom) return;
        setResourcesStatus('error');
        setResourcesError(error.message || 'Unable to load room resources.');
      });

    return () => {
      isCurrentRoom = false;
    };
  }, [room, resourcesReload]);

  const currentPage = navigation.find((item) => item.id === activePage);

  function navigate(page) {
    setActivePage(page);
    setMobileNavOpen(false);
  }

  function refreshDashboard() {
    setDashboardReload((current) => current + 1);
  }

  async function joinRoom(event) {
    event.preventDefault();
    if (roomActionInProgress.current) return;
    const nextRoom = roomInput.trim();
    if (!ROOM_ID_PATTERN.test(nextRoom)) {
      setRoomError('Room IDs must be 1-80 letters, numbers, hyphens, or underscores.');
      setRoomNotice('');
      setActivePage('room');
      return;
    }

    roomActionInProgress.current = true;
    setIsJoiningRoom(true);
    setRoomError('');
    setRoomNotice('');
    try {
      const response = await fetch(`${API}/api/rooms/${encodeURIComponent(nextRoom)}/join`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await readApiResponse(response);
      if (data.room?.id !== nextRoom) throw new Error('The server did not confirm the requested study room.');
      activeRoom.current = nextRoom;
      setRoom(nextRoom);
      setRoomInput(nextRoom);
      setNotesReload((current) => current + 1);
      setResourcesReload((current) => current + 1);
      setRoomNotice(`Joined study room ${nextRoom}.`);
      setActivePage('room');
      refreshDashboard();
    } catch (error) {
      setRoomError(error.message || 'Unable to join this study room. Check your connection and try again.');
      setActivePage('room');
    } finally {
      roomActionInProgress.current = false;
      setIsJoiningRoom(false);
    }
  }

  async function createRoom() {
    if (roomActionInProgress.current) return;
    roomActionInProgress.current = true;
    setIsJoiningRoom(true);
    setRoomError('');
    setRoomNotice('');
    try {
      const response = await fetch(`${API}/api/rooms`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await readApiResponse(response);
      const roomId = data.room?.id;
      if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
        throw new Error('The server returned an invalid study room ID.');
      }
      activeRoom.current = roomId;
      setRoomInput(roomId);
      setRoom(roomId);
      setNotesReload((current) => current + 1);
      setResourcesReload((current) => current + 1);
      setRoomNotice('Study room created and ready to share.');
      setActivePage('room');
      refreshDashboard();
    } catch (error) {
      setRoomError(error.message || 'Unable to create a study room. Check your connection and try again.');
    } finally {
      roomActionInProgress.current = false;
      setIsJoiningRoom(false);
    }
  }

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(room);
      setRoomCopied(true);
      setRoomNotice('Room ID copied to clipboard.');
      window.setTimeout(() => setRoomCopied(false), 2000);
    } catch {
      setRoomError('Unable to copy the room ID. Select and copy it manually.');
    }
  }

  async function submitAuthForm(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    setAuthNotice('');
    try {
      if (authMode === 'profile') {
        const response = await fetch(`${API}/api/auth/profile`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: authForm.name }),
        });
        const data = await readApiResponse(response);
        setAuthUser(data.user);
        setAuthNotice('Profile updated.');
      } else {
        const route = {
          login: 'login',
          register: 'register',
          forgot: 'forgot-password',
          reset: 'reset-password',
        }[authMode];
        const payload = authMode === 'reset'
          ? { password: authForm.password }
          : authMode === 'forgot'
            ? { email: authForm.email }
            : { ...authForm };
        const response = await fetch(`${API}/api/auth/${route}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await readApiResponse(response);
        if (authMode === 'login') {
          setAuthUser(data.user);
          setAuthForm({ name: data.user.name, email: data.user.email, password: '' });
          setAuthMode('profile');
          refreshDashboard();
        } else if (authMode === 'register') {
          setAuthForm((current) => ({ ...current, password: '' }));
          setAuthMode('login');
        } else if (authMode === 'reset') {
          setAuthForm((current) => ({ ...current, password: '' }));
          setAuthMode('login');
        }
        setAuthNotice(data.message || 'Request completed.');
      }
    } catch (error) {
      setAuthError(error.message || 'Unable to complete the account request.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitFirebaseAuth(provider) {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    setAuthNotice('');
    let firebaseUser = null;

    try {
      const auth = await prepareFirebaseAuth();
      if (provider === 'email' && authMode === 'register') {
        const name = authForm.name.trim();
        if (!name) throw new Error('Enter your name before creating a Firebase account.');
        if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
          throw new Error('Names must contain 1-80 printable characters.');
        }
        const email = authForm.email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
        if (authForm.password.length < 10 || authForm.password.length > 128) {
          throw new Error('Passwords must be 10-128 characters long.');
        }
        const credential = await createUserWithEmailAndPassword(auth, email, authForm.password);
        firebaseUser = credential.user;
        await updateProfile(firebaseUser, { displayName: name });
        await sendEmailVerification(firebaseUser);
        await firebaseSignOut(auth);
        setAuthForm((current) => ({ ...current, password: '' }));
        setAuthMode('login');
        setAuthNotice('Firebase account created. Verify your email using Firebase, then sign in.');
        return;
      }

      if (provider === 'email') {
        const email = authForm.email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !authForm.password || authForm.password.length > 128) {
          throw new Error('Enter a valid email address and password.');
        }
        const credential = await signInWithEmailAndPassword(auth, email, authForm.password);
        firebaseUser = credential.user;
      } else {
        const credential = await signInWithPopup(auth, new GoogleAuthProvider());
        firebaseUser = credential.user;
      }

      if (!firebaseUser.emailVerified) {
        await sendEmailVerification(firebaseUser);
        await firebaseSignOut(auth);
        setAuthNotice('Verify your email using the Firebase verification message before signing in.');
        return;
      }

      const idToken = await firebaseUser.getIdToken(true);
      const response = await fetch(`${API}/api/auth/firebase-session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await readApiResponse(response);
      setAuthUser(data.user);
      setAuthForm({ name: data.user.name, email: data.user.email, password: '' });
      setAuthMode('profile');
      setAuthNotice('Signed in with Firebase.');
      refreshDashboard();
    } catch (error) {
      if (firebaseUser && firebaseAuth?.currentUser?.uid === firebaseUser.uid) {
        try {
          await firebaseSignOut(firebaseAuth);
        } catch {
          setAuthError('Firebase sign-in failed and the Firebase session could not be cleared. Sign out from Firebase and try again.');
          return;
        }
      }
      if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') {
        setAuthNotice('Google sign-in was cancelled.');
      } else if (error?.code === 'auth/popup-blocked') {
        setAuthError('The browser blocked the Google sign-in popup. Allow popups for this site and try again.');
      } else if (error?.code === 'auth/unauthorized-domain') {
        setAuthError('This website is not an authorized Firebase domain. Add its hostname in Firebase Authentication settings.');
      } else {
        setAuthError(error.message || 'Firebase sign-in could not be completed.');
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function resendVerification() {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    setAuthNotice('');
    try {
      const response = await fetch(`${API}/api/auth/verification/resend`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authForm.email }),
      });
      const data = await readApiResponse(response);
      setAuthNotice(data.message || 'Verification request completed.');
    } catch (error) {
      setAuthError(error.message || 'Unable to send a verification email.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const response = await fetch(`${API}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await readApiResponse(response);
      setAuthUser(null);
      setAuthForm({ name: '', email: '', password: '' });
      setAuthMode('login');
      setAuthNotice(data.message || 'You have signed out.');
      refreshDashboard();
      if (firebaseAuth?.currentUser) {
        try {
          await firebaseSignOut(firebaseAuth);
        } catch {
          setAuthError('You have signed out of StudySphere, but Firebase could not sign out on this device. Sign out from Firebase and try again.');
        }
      }
    } catch (error) {
      setAuthError(error.message || 'Unable to sign out.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveNotes() {
    if (saveInProgress.current) return;
    if (!notes.trim()) {
      setNotesStatus('error');
      setNotesError('Write a note before saving.');
      return;
    }
    saveInProgress.current = true;
    setIsSavingNotes(true);
    setNotesStatus('saving');
    setNotesError('');
    const roomToSave = room;
    const textToSave = notes;
    pendingNotesSave.current = { room: roomToSave, text: textToSave };
    try {
      const response = await fetch(`${API}/api/notes/${encodeURIComponent(roomToSave)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSave }),
      });
      await readApiResponse(response);
      if (activeRoom.current === roomToSave) {
        savedNotesValue.current = textToSave;
        const currentTextWasSaved = notesValue.current === textToSave;
        setNotesStatus(currentTextWasSaved ? 'synced' : 'unsaved');
        if (currentTextWasSaved) setNotesError('');
        setNotesLoadError(false);
        refreshDashboard();
      }
    } catch (error) {
      if (activeRoom.current === roomToSave) {
        setNotesStatus('error');
        setNotesLoadError(false);
        setNotesError(error.message || 'Unable to save notes. Check your connection and try again.');
      }
    } finally {
      pendingNotesSave.current = null;
      saveInProgress.current = false;
      setIsSavingNotes(false);
    }
  }

  async function uploadResource(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || uploadInProgress.current) return;

    setResourcesError('');
    setResourcesNotice('');
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setResourcesError('Choose a PDF, JPEG, PNG, or WebP file.');
      input.value = '';
      return;
    }
    if (file.size === 0 || file.size > 10 * 1024 * 1024) {
      setResourcesError('Files must be smaller than 10 MB and cannot be empty.');
      input.value = '';
      return;
    }

    uploadInProgress.current = true;
    setIsUploadingResource(true);
    setResourcesError('');
    setResourcesNotice('');
    const roomToUpload = room;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Unable to read the selected file.'));
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${API}/api/resources/${encodeURIComponent(roomToUpload)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mimeType: file.type, data: dataUrl }),
      });
      const result = await readApiResponse(response);
      if (!result.resource) throw new Error('The server did not return the uploaded resource.');
      if (activeRoom.current === roomToUpload) {
        setResources((current) => [result.resource, ...current.filter((item) => item.id !== result.resource.id)]);
        setResourcesNotice('Your resource was uploaded to this room.');
        setResourcesStatus('loaded');
        refreshDashboard();
      }
    } catch (error) {
      if (activeRoom.current === roomToUpload) {
        setResourcesError(error.message || 'Unable to upload the resource.');
      }
    } finally {
      uploadInProgress.current = false;
      setIsUploadingResource(false);
      input.value = '';
    }
  }

  async function deleteResource(resource) {
    if (deletingResourceId) return;
    setDeletingResourceId(resource.id);
    setResourcesError('');
    setResourcesNotice('');
    const roomToDelete = room;
    try {
      const response = await fetch(
        `${API}/api/resources/${encodeURIComponent(roomToDelete)}/${encodeURIComponent(resource.id)}`,
        { method: 'DELETE' },
      );
      await readApiResponse(response);
      if (activeRoom.current === roomToDelete) {
        setResources((current) => current.filter((item) => item.id !== resource.id));
        setSelectedResource((current) => current?.id === resource.id ? null : current);
        setResourcesNotice('The resource was removed from this room.');
        refreshDashboard();
      }
    } catch (error) {
      if (activeRoom.current === roomToDelete) {
        setResourcesError(error.message || 'Unable to delete the resource.');
      }
    } finally {
      setDeletingResourceId('');
    }
  }

  async function previewResource(resource) {
    setResourcesError('');
    if (resource.mimeType !== 'application/pdf') {
      setSelectedResource(resource);
      return;
    }

    const roomToPreview = room;
    setPreviewingResourceId(resource.id);
    try {
      const response = await fetch(
        `${API}/api/resources/${encodeURIComponent(roomToPreview)}/${encodeURIComponent(resource.id)}/preview`,
      );
      const result = await readApiResponse(response);
      if (activeRoom.current === roomToPreview) setSelectedResource({ ...resource, url: result.url });
    } catch (error) {
      if (activeRoom.current === roomToPreview) {
        setResourcesError(error.message || 'Unable to preview the PDF.');
      }
    } finally {
      setPreviewingResourceId('');
    }
  }

  async function askAssistant(provider) {
    if (askInProgress.current) return;
    const question = prompt.trim();
    if (!question) {
      setSelectedProvider(provider);
      setAnswer({ provider, error: 'Add a question before asking the assistant.' });
      return;
    }
    askInProgress.current = true;
    setSelectedProvider(provider);
    setIsAsking(true);
    setAnswer(null);
    try {
      const response = await fetch(`${API}/api/ai/${provider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: question }),
      });
      const data = await readApiResponse(response);
      if (!data.text) throw new Error(`The ${provider} assistant returned an empty response.`);
      setAnswer({ provider, text: data.text });
      setPrompt((currentPrompt) => currentPrompt.trim() === question ? '' : currentPrompt);
    } catch (error) {
      setAnswer({ provider, error: error.message || `Unable to reach ${provider}. Check the API server and try again.` });
    } finally {
      askInProgress.current = false;
      setIsAsking(false);
    }
  }

  function renderOverview() {
    return (
      <>
        <section className="welcome-panel">
          <div className="welcome-copy">
            <span className="eyebrow light-eyebrow">YOUR STUDY SPACE</span>
            <h2>Make room for<br />a little more <em>focus.</em></h2>
            <p>Bring your study group together, share ideas, and make progress at your own pace.</p>
            <button className="button button-light" onClick={() => navigate('room')}>Open your study room <Icon name="arrow" size={17} /></button>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="orbit orbit-one" /><div className="orbit orbit-two" />
            <div className="art-card art-card-main"><Icon name="book" size={25} /><span>Deep work</span><strong>One step at a time.</strong></div>
            <div className="art-card art-card-float"><span className="art-dot" /> Room is ready</div>
            <div className="art-sparkle">✦</div>
          </div>
        </section>

        <div className="section-heading overview-heading">
          <div><span className="eyebrow">YOUR DASHBOARD</span><h2>A clearer view of your work</h2></div>
          <span className="demo-label">{dashboard?.scope === 'your rooms' ? 'Your created rooms' : 'Community data'}</span>
        </div>
        <section className="stats-grid" aria-label="Live study statistics" aria-live="polite">
          <article className="stat-card"><span className="stat-icon lilac"><Icon name="users" /></span><div><p>Study rooms</p><strong>{dashboardStatus === 'loaded' ? dashboard.stats.rooms : '—'}</strong><span className="stat-note">{dashboardStatus === 'loading' ? 'Loading…' : dashboardStatus === 'error' ? 'Unavailable' : dashboard?.scope === 'your rooms' ? 'Created by you' : 'Community total'}</span></div><span className="stat-spark spark-lilac" aria-hidden="true">⌁</span></article>
          <article className="stat-card"><span className="stat-icon blue"><Icon name="note" /></span><div><p>Notes saved</p><strong>{dashboardStatus === 'loaded' ? dashboard.stats.notes : '—'}</strong><span className="stat-note">{dashboardStatus === 'loading' ? 'Loading…' : dashboardStatus === 'error' ? 'Unavailable' : dashboard?.scope === 'your rooms' ? 'In your rooms' : 'Community total'}</span></div><span className="stat-spark spark-blue" aria-hidden="true">⌁</span></article>
          <article className="stat-card"><span className="stat-icon peach"><Icon name="folder" /></span><div><p>Resources shared</p><strong>{dashboardStatus === 'loaded' ? dashboard.stats.resources : '—'}</strong><span className="stat-note">{dashboardStatus === 'loading' ? 'Loading…' : dashboardStatus === 'error' ? 'Unavailable' : dashboard?.scope === 'your rooms' ? 'In your rooms' : 'Community total'}</span></div><span className="stat-spark spark-peach" aria-hidden="true">⌁</span></article>
        </section>

        <div className="content-grid">
          <section className="panel activity-panel">
            <div className="panel-heading"><div><h3>Recent activity</h3><p>{dashboardStatus === 'loaded' ? `Recent changes in ${dashboard.scope}.` : 'Actual room and resource activity.'}</p></div><span className="panel-menu" aria-hidden="true">•••</span></div>
            {dashboardStatus === 'loading' && <p className="dashboard-message" aria-live="polite">Loading dashboard activity…</p>}
            {dashboardStatus === 'error' && <div className="inline-error" role="alert">{dashboardError}<button className="retry-button" onClick={refreshDashboard}>Retry dashboard</button></div>}
            {dashboardStatus === 'loaded' && dashboard.activity.length === 0 && <p className="dashboard-message">No rooms, notes, or resources have been recorded here yet.</p>}
            {dashboardStatus === 'loaded' && dashboard.activity.length > 0 && <div className="activity-list">
              {dashboard.activity.map((item, index) => <div className="activity-item" key={`${item.kind}-${item.title}-${index}`}>
                <span className={`activity-icon ${item.kind === 'notes' ? 'activity-purple' : item.kind === 'resource' ? 'activity-blue' : 'activity-green'}`}><Icon name={item.kind === 'notes' ? 'note' : item.kind === 'resource' ? 'folder' : 'users'} size={17} /></span>
                <div><strong>{item.title}</strong><p>{item.kind === 'notes' ? 'Shared note document updated' : item.kind === 'resource' ? 'Resource added to a study room' : 'Room is ready to join'}</p></div>
                <span className="activity-time">{new Date(item.at).toLocaleDateString()}</span>
              </div>)}
            </div>}
          </section>
          <section className="panel quick-panel">
            <div className="panel-heading"><div><h3>Quick actions</h3><p>Pick up where you want to begin</p></div></div>
            <button className="quick-action" onClick={() => navigate('notes')}><span className="quick-icon quick-purple"><Icon name="note" /></span><span><strong>Open shared notes</strong><small>Write and save to your room</small></span><Icon name="arrow" size={17} /></button>
            <button className="quick-action" onClick={() => navigate('assistant')}><span className="quick-icon quick-blue"><Icon name="sparkle" /></span><span><strong>Ask the AI assistant</strong><small>Get help with a study question</small></span><Icon name="arrow" size={17} /></button>
            <button className="quick-action" onClick={() => navigate('room')}><span className="quick-icon quick-peach"><Icon name="users" /></span><span><strong>Go to your study room</strong><small>Current room · {room}</small></span><Icon name="arrow" size={17} /></button>
          </section>
        </div>
      </>
    );
  }

  function renderRoom() {
    return (
      <div className="page-stack">
        <section className="room-banner">
          <div><span className="eyebrow light-eyebrow">YOUR SHARED SPACE</span><h2>Study better, together.</h2><p>Use the room ID to open shared notes with your study group.</p></div>
          <span className={`connection-pill ${socketStatus === 'connected' ? 'is-connected' : ''}`}><span />{socketStatus === 'connected' ? 'Socket connected' : 'Socket disconnected'}</span>
        </section>
        <section className="panel room-join-panel">
          <div className="panel-heading"><div><h3>Join a study room</h3><p>Use the same room ID as your study group.</p></div><span className="room-icon"><Icon name="users" size={22} /></span></div>
          <form className="room-form" onSubmit={joinRoom}><label htmlFor="room-id">Room ID</label><div className="room-input-row"><input id="room-id" maxLength={80} value={roomInput} onChange={(event) => setRoomInput(event.target.value)} placeholder="e.g. study-room-1" /><button className="button button-primary" type="submit" disabled={isJoiningRoom}>{isJoiningRoom ? 'Joining…' : 'Join room'} <Icon name="arrow" size={16} /></button><button className="button button-outline" type="button" onClick={createRoom} disabled={isJoiningRoom}><Icon name="plus" size={16} />{isJoiningRoom ? 'Please wait…' : 'Create room'}</button></div></form>
          {roomError && <div className="inline-error" role="alert">{roomError}</div>}
          {roomNotice && <div className="resource-notice" role="status">{roomNotice}</div>}
          <div className="active-room-row"><span className={`status-dot${socketStatus === 'connected' ? '' : ' status-dot-offline'}`} />Active room <strong>{room}</strong><button className="room-copy-button" type="button" onClick={copyRoomId}>{roomCopied ? 'Copied' : 'Copy ID'}</button></div>
        </section>
        <div className="content-grid room-content-grid">
          <section className="panel workspace-card"><span className="workspace-illustration"><Icon name="note" size={27} /></span><span className="eyebrow">SHARED WORKSPACE</span><h3>Keep your ideas in one place</h3><p>Open shared notes to add thoughts and save them to the active room.</p><button className="text-action" onClick={() => navigate('notes')}>Go to shared notes <Icon name="arrow" size={16} /></button></section>
          <section className="panel workspace-card assistant-workspace"><span className="workspace-illustration"><Icon name="sparkle" size={27} /></span><span className="eyebrow">STUDY SUPPORT</span><h3>A helpful nudge, when you need it</h3><p>Ask Groq or Gemini a question through your configured backend.</p><button className="text-action" onClick={() => navigate('assistant')}>Open AI assistant <Icon name="arrow" size={16} /></button></section>
        </div>
      </div>
    );
  }

  function renderNotes() {
    return (
      <div className="page-stack">
        <section className="section-heading page-heading"><div><span className="eyebrow">STUDY TOGETHER</span><h2>Shared notes</h2><p>Write down the ideas worth keeping. Save them to your active room.</p></div></section>
        <section className="panel notes-panel">
          <div className="notes-toolbar"><div className="notes-room"><span className={`status-dot${socketStatus === 'connected' ? '' : ' status-dot-offline'}`} /><span>Room</span><strong>{room}</strong></div><div className={`sync-status sync-${notesStatus}`} aria-live="polite"><span className="sync-dot" />{notesStatus === 'loading' ? 'Loading notes…' : notesStatus === 'saving' ? 'Saving…' : notesStatus === 'error' ? 'Sync issue' : notesStatus === 'unsaved' ? 'Unsaved changes' : 'Saved to room'}</div></div>
          {notesError && <div className="inline-error" role="alert">{notesError}</div>}
          {notesLoadError && <button className="retry-button" onClick={() => setNotesReload((current) => current + 1)}>Retry loading room</button>}
          <label className="sr-only" htmlFor="shared-notes">Notes for {room}</label>
          <textarea id="shared-notes" className="notes-editor" value={notes} onChange={(event) => { notesValue.current = event.target.value; setNotes(event.target.value); setNotesStatus('unsaved'); setNotesError(''); }} placeholder="Start with a question, a key idea, or a quick summary…" />
          <div className="notes-footer"><span>Notes are saved to the active room when you select Save notes.</span><button className="button button-primary" type="button" onClick={saveNotes} disabled={isSavingNotes || notesStatus === 'loading'}><Icon name="check" size={17} />{isSavingNotes ? 'Saving…' : 'Save notes'}</button></div>
        </section>
        <div className="callout"><Icon name="users" size={18} /><p>Anyone who joins <strong>{room}</strong> can access notes saved in that room.</p></div>
      </div>
    );
  }

  function renderAssistant() {
    return (
      <div className="page-stack assistant-page">
        <section className="section-heading page-heading"><div><span className="eyebrow">STUDY SUPPORT</span><h2>AI study assistant</h2><p>Explore an idea or get a fresh explanation from your configured provider.</p></div></section>
        <section className="panel assistant-panel">
          <div className="assistant-top"><div className="assistant-avatar"><Icon name="sparkle" size={23} /></div><div><h3>Your study companion</h3><p>Choose a provider to send your question.</p></div><span className="private-label">Backend powered</span></div>
          <div className="chat-area" aria-live="polite">
            {!answer && !isAsking && <div className="assistant-empty"><span className="empty-sparkle"><Icon name="sparkle" size={22} /></span><h3>What are you working on?</h3><p>Ask a question and your selected AI provider will respond here.</p><div className="suggestion-chips"><button onClick={() => setPrompt('Can you explain this concept in simple terms?')}>Explain a concept</button><button onClick={() => setPrompt('Help me make a study plan for an upcoming exam.')}>Plan a study session</button></div></div>}
            {isAsking && <div className="loading-answer"><span className="loading-spinner" /><div><strong>Putting an explanation together…</strong><p>Your question is being sent to the selected provider.</p></div></div>}
            {answer && <article className={`answer-card${answer.error ? ' answer-error' : ''}`}><div className="answer-heading"><span className="answer-avatar"><Icon name={answer.error ? 'close' : 'sparkle'} size={17} /></span><div><strong>{answer.error ? 'Request could not be completed' : `${answer.provider === 'groq' ? 'Groq' : 'Gemini'} response`}</strong><small>{answer.error ? 'Check the message below' : 'AI-generated study support'}</small></div></div>{answer.error ? <p role="alert">{answer.error}</p> : <div className="answer-text">{answer.text}</div>}</article>}
          </div>
          <div className="assistant-compose"><label className="sr-only" htmlFor="assistant-prompt">Your study question</label><textarea id="assistant-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askAssistant(selectedProvider); } }} placeholder="Ask a question about your studies…" rows="3" /><div className="compose-bottom"><span>Enter to ask selected provider · Shift + Enter for a new line</span><div className="provider-buttons"><button className="button button-outline" disabled={isAsking} onClick={() => askAssistant('gemini')}>Ask Gemini <Icon name="send" size={15} /></button><button className="button button-primary" disabled={isAsking} onClick={() => askAssistant('groq')}>Ask Groq <Icon name="send" size={15} /></button></div></div></div>
          <p className="ai-disclaimer">AI responses can be inaccurate. Review important information with trusted sources.</p>
        </section>
      </div>
    );
  }

  function renderResources() {
    return (
      <div className="page-stack">
        <section className="section-heading page-heading"><div><span className="eyebrow">YOUR MATERIALS</span><h2>Resources</h2><p>Upload PDFs and images to share them with your active room.</p></div></section>
        <section className="panel resource-panel">
          <div className="resource-toolbar">
            <div><strong>Room resources</strong><p>Files are shared with anyone who joins {room}. Maximum file size: 10 MB.</p></div>
            <label className={`button button-primary${isUploadingResource ? ' resource-uploading' : ''}`} htmlFor="resource-upload" aria-disabled={isUploadingResource}>
              <Icon name="plus" size={16} />{isUploadingResource ? 'Uploading…' : 'Upload resource'}
            </label>
            <input id="resource-upload" className="sr-only" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={uploadResource} disabled={isUploadingResource} />
          </div>
          {resourcesError && <div className="inline-error" role="alert">{resourcesError}</div>}
          {resourcesNotice && <div className="resource-notice" role="status">{resourcesNotice}</div>}
          {resourcesStatus === 'loading' && <p className="resource-message" aria-live="polite">Loading room resources…</p>}
          {resourcesStatus === 'error' && <button className="retry-button" onClick={() => setResourcesReload((current) => current + 1)}>Retry loading resources</button>}
          {resourcesStatus === 'loaded' && resources.length === 0 && <div className="empty-panel resource-empty"><span className="empty-icon"><Icon name="folder" size={27} /></span><h3>No resources here yet</h3><p>Upload a PDF or image to make it available to your study group.</p></div>}
          {resources.length > 0 && <div className="resource-list">
            {resources.map((resource) => <article className="resource-item" key={resource.id}>
              <span className="resource-icon"><Icon name={resource.mimeType === 'application/pdf' ? 'book' : 'folder'} size={19} /></span>
              <button className="resource-open" type="button" onClick={() => previewResource(resource)} disabled={previewingResourceId === resource.id}><strong>{resource.name}</strong><small>{previewingResourceId === resource.id ? 'Checking preview…' : `${(resource.size / (1024 * 1024)).toFixed(2)} MB · ${new Date(resource.createdAt).toLocaleDateString()}`}</small></button>
              <button className="resource-delete" type="button" onClick={() => deleteResource(resource)} disabled={Boolean(deletingResourceId)} aria-label={`Delete ${resource.name}`}>{deletingResourceId === resource.id ? 'Removing…' : 'Remove'}</button>
            </article>)}
          </div>}
          {selectedResource && <div className="resource-preview">
            <div className="resource-preview-heading"><strong>{selectedResource.name}</strong><button className="resource-delete" type="button" onClick={() => setSelectedResource(null)}>Close preview</button></div>
            {selectedResource.mimeType === 'application/pdf'
              ? <iframe title={`Preview of ${selectedResource.name}`} src={selectedResource.url} />
              : <img src={selectedResource.url} alt={selectedResource.name} />}
          </div>}
        </section>
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="page-stack">
        <section className="section-heading page-heading"><div><span className="eyebrow">PREFERENCES</span><h2>Settings</h2><p>Account, room, and connection details for this study space.</p></div></section>
        <section className="panel auth-panel">
          <div className="panel-heading"><div><h3>{authUser ? 'Your account' : authMode === 'register' ? 'Create an account' : authMode === 'forgot' ? 'Forgot password' : authMode === 'reset' ? 'Choose a new password' : authMode === 'verify' ? 'Verifying email' : 'Sign in or register'}</h3><p>{authUser ? `Signed in as ${authUser.email}.` : 'Accounts add a verified profile and private dashboard statistics. Study rooms remain public to join.'}</p></div><span className="room-icon"><Icon name="users" size={22} /></span></div>
          {authMode === 'verify' && <p className="dashboard-message" aria-live="polite">Checking the verification link…</p>}
          {authUser && authMode === 'profile' ? (
            <form className="auth-form" onSubmit={submitAuthForm}>
              <label htmlFor="account-name">Display name</label>
              <input id="account-name" autoComplete="name" maxLength={80} value={authForm.name} onChange={(event) => setAuthForm((current) => ({ ...current, name: event.target.value }))} required />
              <label htmlFor="account-email">Email address</label>
              <input id="account-email" value={authUser.email} readOnly />
              <div className="auth-actions"><button className="button button-primary" type="submit" disabled={authBusy}>{authBusy ? 'Saving…' : 'Save profile'}</button><button className="button button-outline" type="button" onClick={logout} disabled={authBusy}>{authBusy ? 'Please wait…' : 'Sign out'}</button></div>
            </form>
          ) : authMode !== 'verify' && (
            <form className="auth-form" onSubmit={submitAuthForm}>
              {(authMode === 'register' || authMode === 'profile') && <><label htmlFor="auth-name">Name</label><input id="auth-name" autoComplete="name" maxLength={80} value={authForm.name} onChange={(event) => setAuthForm((current) => ({ ...current, name: event.target.value }))} required /></>}
              {authMode !== 'reset' && <><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" autoComplete="email" maxLength={254} value={authForm.email} onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))} required /></>}
              {(authMode === 'login' || authMode === 'register' || authMode === 'reset') && <><label htmlFor="auth-password">{authMode === 'reset' ? 'New password' : 'Password'}</label><input id="auth-password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={10} maxLength={128} value={authForm.password} onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))} required /></>}
              <div className="auth-actions">
                <button className="button button-primary" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'register' ? 'Create account' : authMode === 'forgot' ? 'Request reset link' : authMode === 'reset' ? 'Reset password' : 'Sign in'}</button>
                {authMode === 'login' && <button className="auth-text-button" type="button" onClick={resendVerification} disabled={authBusy || !authForm.email}>Resend verification email</button>}
              </div>
              {(authMode === 'login' || authMode === 'register') && <div className="auth-firebase-options">
                <p>Or use Firebase Authentication</p>
                {firebaseAuthError && <p className="dashboard-message" role="status">{firebaseAuthError}</p>}
                <div className="auth-actions">
                  <button className="button button-outline" type="button" onClick={() => submitFirebaseAuth('email')} disabled={authBusy || !firebaseAuth}>
                    {authBusy ? 'Please wait…' : authMode === 'register' ? 'Create Firebase email account' : 'Sign in with Firebase email'}
                  </button>
                  <button className="button button-outline" type="button" onClick={() => submitFirebaseAuth('google')} disabled={authBusy || !firebaseAuth}>
                    {authBusy ? 'Please wait…' : 'Continue with Google'}
                  </button>
                </div>
              </div>}
              <div className="auth-switches">
                {authMode !== 'login' && <button type="button" onClick={() => { setAuthMode('login'); setAuthError(''); setAuthNotice(''); }}>Sign in</button>}
                {authMode !== 'register' && <button type="button" onClick={() => { setAuthMode('register'); setAuthError(''); setAuthNotice(''); }}>Create account</button>}
                {(authMode === 'login' || authMode === 'register') && <button type="button" onClick={() => { setAuthMode('forgot'); setAuthError(''); setAuthNotice(''); }}>Forgot password?</button>}
              </div>
            </form>
          )}
          {authMode !== 'verify' && authError && <div className="inline-error" role="alert">{authError}</div>}
          {authMode !== 'verify' && authNotice && <div className="auth-notice" role="status">{authNotice}</div>}
          {authError && authMode === 'verify' && <div className="inline-error" role="alert">{authError}</div>}
          {authNotice && authMode === 'verify' && <div className="auth-notice" role="status">{authNotice}</div>}
        </section>
        <section className="panel settings-panel">
          <div className="settings-row"><span className="settings-icon"><Icon name="users" /></span><div><strong>Active study room</strong><p>Notes and resources are scoped to this room.</p></div><span className="settings-value">{room}</span></div>
          <div className="settings-row"><span className="settings-icon"><Icon name="sparkle" /></span><div><strong>Backend and AI providers</strong><p>{healthError || (serverHealth ? `MongoDB ${serverHealth.database}; Groq ${serverHealth.providers.groq ? 'configured' : 'key missing'}; Gemini ${serverHealth.providers.gemini ? 'configured' : 'key missing'}.` : 'Checking backend status…')}</p></div><span className={`settings-value${serverHealth?.database !== 'connected' ? ' value-muted' : ''}`}>{serverHealth?.database === 'connected' ? 'Connected' : healthError ? 'Unavailable' : 'Checking'}</span></div>
          <div className="settings-row"><span className="settings-icon"><Icon name="folder" /></span><div><strong>Resources and email</strong><p>{serverHealth ? `Cloudinary ${serverHealth.cloudinary ? 'configured' : 'keys missing'}; email delivery ${serverHealth.email?.configured ? 'configured' : `missing ${serverHealth.email?.missing?.join(', ') || 'SMTP settings'}`}.` : 'Checking Cloudinary and SMTP configuration…'}</p></div><span className={`settings-value${serverHealth?.cloudinary ? '' : ' value-muted'}`}>{serverHealth?.cloudinary ? 'Available' : 'Not enabled'}</span></div>
        </section>
      </div>
    );
  }

  const pageContent = {
    overview: renderOverview,
    room: renderRoom,
    notes: renderNotes,
    assistant: renderAssistant,
    resources: renderResources,
    settings: renderSettings,
  }[activePage]();

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar${mobileNavOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-brand"><Brand /><button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><Icon name="close" /></button></div>
        <div className="workspace-switch"><span className="workspace-avatar">S</span><span><strong>Study workspace</strong><small>Personal space</small></span><span className="switch-chevron">⌄</span></div>
        <span className="nav-label">MENU</span>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => <button key={item.id} className={`nav-link${activePage === item.id ? ' nav-link-active' : ''}`} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'room' && <span className="nav-room-dot" />}</button>)}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-help-icon"><Icon name="sparkle" size={18} /></div><strong>Small steps add up.</strong><p>Your next good study session starts here.</p><button onClick={() => navigate('room')}>Open study room <Icon name="arrow" size={14} /></button></div>
        <button className="profile-row" type="button" onClick={() => navigate('settings')}><span className="profile-avatar">{authUser?.name?.slice(0, 1).toUpperCase() || 'S'}</span><span><strong>{authUser?.name || 'Study member'}</strong><small>{authUser ? authUser.email : 'Sign in or create account'}</small></span><span className="profile-menu">•••</span></button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Icon name="menu" /></button>
          <div className="breadcrumb"><span>StudySphere</span><span className="breadcrumb-slash">/</span><strong>{currentPage.label}</strong></div>
          <form className="topbar-room-form" onSubmit={joinRoom}><label htmlFor="header-room">Room ID</label><input id="header-room" value={roomInput} onChange={(event) => setRoomInput(event.target.value)} aria-label="Room ID" /><button type="submit" disabled={isJoiningRoom}>{isJoiningRoom ? '…' : 'Join'}</button></form>
        </header>
        <div className="page-content">
          {activePage === 'overview' &&           <div className="page-title-row"><div><span className="eyebrow">{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</span><h1>Welcome to your space <span className="wave">✦</span></h1><p>A little progress today goes a long way.</p></div><button className="button button-primary header-action" onClick={() => navigate('room')}><Icon name="plus" size={17} />Start studying</button></div>}
          {pageContent}
          <footer className="page-footer"><span>StudySphere</span><span>Built for better study sessions</span></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
