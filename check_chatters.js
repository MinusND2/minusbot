async function check() {
    const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
            'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Origin': 'https://www.twitch.tv'
        },
        body: JSON.stringify([{
            operationName: 'ChannelShell',
            variables: { login: 'kickbasekis' },
            query: `query ChannelShell($login: String!) {
                user(login: $login) {
                    login
                    displayName
                    stream { id type viewersCount title }
                }
            }`
        }])
    });
    const d = await res.json();
    console.log('KICKBASEKIS STREAM:', JSON.stringify(d[0]?.data?.user, null, 2));
}
check();
