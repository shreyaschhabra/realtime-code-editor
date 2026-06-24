import './App.css';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import Auth from './pages/Auth';
import EditorPage from './pages/EditorPage';

function App() {
    const [username, setUsername] = useState(localStorage.getItem('username'));

    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<Auth onLogin={setUsername} loggedIn={!!username} />} />
                <Route path="/editor/:roomId" element={<EditorPage />} />
            </Routes>
        </BrowserRouter>
    );
}

export default App;
